// 对本次改动的源文件运行项目配置的变异测试，并拉回最终提交的 CI 报告供复审使用。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { defaultGh, isMain, isSourceFile, prNumber, repoRoot, runGh } from './lib.mjs';
import { changedBetween, metricsConfig, readRunArtifacts } from './test-ledger.mjs';

const STATUS_SCHEMA = 'ek-mutation-status/1';

/** 报告旁的状态文件路径：与报告同目录，固定名 mutation-status.json（CI 作业把两份一起上传）。 */
function statusPath(out) {
  return path.join(path.dirname(out), 'mutation-status.json');
}

/**
 * 运行项目的变异命令，两个输出流直接写入同一报告，并在报告旁写 mutation-status.json（schema、exitCode、files，
 * 跳过时带 skipped），返回命令退出码。CI 上这一步 continue-on-error、超时放在步骤级：作业本身总成功，真实结果看状态文件；
 * 步骤超时被杀时状态文件不会写出，拉回时据此判断“可能超时或被取消”。
 */
export function run({ root, base, out = path.join(root, 'mutation-report.txt') }) {
  if (!base) throw new Error('run 缺少 --base 修订');
  const config = metricsConfig(root);
  if (!config.mutationCommand) {
    console.log('未配置 modules.gate.mutationCommand，跳过自动变异测试（沿用人工变异检查）');
    return 0;
  }
  const files = changedBetween(root, base).filter((file) => isSourceFile(file, config));
  if (!files.length) {
    const why = '本次改动没有源文件，跳过自动变异测试';
    fs.writeFileSync(out, why + '\n');
    fs.writeFileSync(statusPath(out), JSON.stringify({ schema: STATUS_SCHEMA, exitCode: 0, files, skipped: '没有源文件' }) + '\n');
    console.log(why);
    return 0;
  }
  const fd = fs.openSync(out, 'w');
  let status;
  try {
    const result = spawnSync(config.mutationCommand, { cwd: root, shell: true, stdio: ['ignore', fd, fd],
      env: { ...process.env, EK_MUTATION_FILES: files.join('\n'), EK_MUTATION_FILES_JSON: JSON.stringify(files) } });
    if (result.error) throw result.error;
    if (result.status === null) throw new Error(`变异命令被信号 ${result.signal} 中断`);
    status = result.status;
  } finally { fs.closeSync(fd); }
  fs.writeFileSync(statusPath(out), JSON.stringify({ schema: STATUS_SCHEMA, exitCode: status, files }) + '\n');
  console.log(`变异测试报告：${path.resolve(out)}`);
  return status;
}

/** 某次运行某次 attempt 里名为 mutation 的作业结论（success、failure、cancelled、timed_out 等）；没有这个作业时返回 null。 */
function mutationConclusion(root, gh, run) {
  const view = JSON.parse(runGh(gh, ['run', 'view', String(run.databaseId), '--attempt', String(run.attempt ?? 1), '--json', 'jobs'], root) || '{}');
  const job = (view.jobs ?? []).find((j) => j.name === 'mutation');
  return job ? String(job.conclusion || job.status || 'unknown').toLowerCase() : null;
}

/** 产物里的状态文件：读不到或格式不对返回 null。 */
function readStatus(dir) {
  for (const file of fs.globSync('**/mutation-status.json', { cwd: dir })) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (s?.schema === STATUS_SCHEMA && Number.isInteger(s.exitCode)) return s;
    } catch { /* 坏的状态文件按没有处理 */ }
  }
  return null;
}

/**
 * 拉回最终提交上的 mutation-report 供复审读取，并写明它可信到什么程度：按 gh run list 的顺序（最新在前），
 * 先找最新一个有 mutation 作业的运行（结论按该次 attempt 读）；报告取自哪个运行就写明哪个；
 * 状态文件 exitCode 为 0 才算完整，非 0、没有状态文件、作业结论不是 success 都写明“报告可能不完整”；
 * 最新运行没有报告而更早的有时，用更早的并写明“可能过期”；报告所在运行找不到 mutation 作业时写明“报告未验证”。
 * 不给 out 时每次写到新建的独占临时目录里，不同仓库、同编号的 PR 不会互相覆盖。
 */
export function pull({ root, pr, out, gh = defaultGh }) {
  const no = prNumber(pr);
  const found = new Map(); // 运行号 → { report, status }
  const { runs } = readRunArtifacts({ root, pr: no, artifact: 'mutation-report', gh }, (dir, run) => {
    const [file] = fs.globSync('**/mutation-report.txt', { cwd: dir });
    if (file) found.set(String(run.databaseId), { report: fs.readFileSync(path.join(dir, file)), status: readStatus(dir) });
  });
  const completed = runs.filter((r) => r.status === 'completed');
  const conclusions = new Map(completed.map((r) => [String(r.databaseId), mutationConclusion(root, gh, r)]));
  const latest = completed.find((r) => conclusions.get(String(r.databaseId)) !== null);
  const source = completed.find((r) => found.has(String(r.databaseId)));
  if (!source) {
    const c = latest && conclusions.get(String(latest.databaseId));
    if (c && c !== 'success' && c !== 'skipped') console.log(`本 PR 的 CI 没有变异测试产物；变异作业结论：${c}（运行 ${latest.databaseId}，作业失败、取消或超时，没有留下报告）`);
    else console.log('本 PR 的 CI 没有变异测试产物（没配置、没带风险标签或作业没跑）');
    return 0;
  }
  const id = String(source.databaseId);
  const { report, status } = found.get(id);
  const target = out ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ek-mutation-')), `ek-mutation-${no}.txt`);
  fs.writeFileSync(target, report);
  const lines = [`报告来自运行 ${id}（第 ${source.attempt ?? 1} 次）`];
  if (latest && String(latest.databaseId) !== id) {
    lines.push(`最新一次运行 ${latest.databaseId} 没有变异报告（作业结论 ${conclusions.get(String(latest.databaseId))}），以下报告来自较早的运行 ${id}，可能过期`);
  }
  const conclusion = conclusions.get(id);
  if (conclusion === null) lines.push('未能确认报告对应的变异作业（报告未验证）');
  else if (conclusion !== 'success') lines.push(`变异作业结论：${conclusion}；报告可能不完整`);
  if (!status) lines.push('没有状态文件：变异步骤可能超时或被取消；报告可能不完整');
  else if (status.exitCode !== 0) lines.push(`变异命令退出码 ${status.exitCode}；报告可能不完整`);
  for (const line of lines) console.log(line);
  console.log(`变异测试报告：${path.resolve(target)}`);
  return 0;
}

if (isMain(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (!['run', 'pull'].includes(command)) throw new Error('命令须为 run 或 pull');
    const options = { out: { type: 'string' }, [command === 'run' ? 'base' : 'pr']: { type: 'string' } };
    const { values } = parseArgs({ args, options });
    process.exitCode = (command === 'run' ? run : pull)({ root: repoRoot(), ...values });
  } catch (error) {
    console.error(`变异测试操作失败：${error.message}`);
    process.exitCode = 1;
  }
}
