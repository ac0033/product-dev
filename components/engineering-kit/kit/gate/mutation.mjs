// 对本次改动的源文件运行项目配置的变异测试，并拉回最终提交的 CI 报告供复审使用。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { defaultGh, isMain, isSourceFile, prNumber, repoRoot, runGh } from './lib.mjs';
import { changedBetween, metricsConfig, readRunArtifacts } from './test-ledger.mjs';

/** 运行项目的变异命令，两个输出流直接写入同一报告并返回命令退出码。 */
export function run({ root, base, out = path.join(root, 'mutation-report.txt') }) {
  if (!base) throw new Error('run 缺少 --base 修订');
  const config = metricsConfig(root);
  if (!config.mutationCommand) {
    console.log('未配置 modules.gate.mutationCommand，跳过自动变异测试（沿用人工变异检查）');
    return 0;
  }
  const files = changedBetween(root, base).filter((file) => isSourceFile(file, config));
  if (!files.length) {
    console.log('本次改动没有源文件，跳过自动变异测试');
    return 0;
  }
  const fd = fs.openSync(out, 'w');
  try {
    const result = spawnSync(config.mutationCommand, { cwd: root, shell: true, stdio: ['ignore', fd, fd],
      env: { ...process.env, EK_MUTATION_FILES: files.join('\n'), EK_MUTATION_FILES_JSON: JSON.stringify(files) } });
    if (result.error) throw result.error;
    if (result.status === null) throw new Error(`变异命令被信号 ${result.signal} 中断`);
    console.log(`变异测试报告：${path.resolve(out)}`);
    return result.status;
  } finally { fs.closeSync(fd); }
}

/** 某次运行里名为 mutation 的作业结论（success、failure、cancelled、timed_out 等）；没有这个作业时返回 null。 */
function mutationConclusion(root, gh, runId) {
  const view = JSON.parse(runGh(gh, ['run', 'view', String(runId), '--json', 'jobs'], root) || '{}');
  const job = (view.jobs ?? []).find((j) => j.name === 'mutation');
  return job ? String(job.conclusion || job.status || 'unknown').toLowerCase() : null;
}

/**
 * 拉回最终提交上最近可用的 mutation-report，成功时打印供复审读取的路径。同时读变异作业的结论：
 * 不是 success 时写明结论和“报告可能不完整”；没有产物而作业失败、取消或超时时报出结论，不说成“没配置”。
 * 不给 out 时每次写到新建的独占临时目录里，不同仓库、同编号的 PR 不会互相覆盖。
 */
export function pull({ root, pr, out, gh = defaultGh }) {
  const no = prNumber(pr);
  let report;
  let from;
  const { missing } = readRunArtifacts({ root, pr: no, artifact: 'mutation-report', gh }, (dir, run) => {
    if (report === undefined) {
      report = fs.readFileSync(path.join(dir, 'mutation-report.txt'));
      from = run.databaseId;
    }
  });
  if (report === undefined) {
    const failed = missing.map((id) => mutationConclusion(root, gh, id)).find((c) => c && c !== 'success' && c !== 'skipped');
    if (failed) console.log(`本 PR 的 CI 没有变异测试产物；变异作业结论：${failed}（作业失败或超时，没有留下报告）`);
    else console.log('本 PR 的 CI 没有变异测试产物（没配置、没带风险标签或作业没跑）');
    return 0;
  }
  const target = out ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ek-mutation-')), `ek-mutation-${no}.txt`);
  fs.writeFileSync(target, report);
  const conclusion = mutationConclusion(root, gh, from);
  if (conclusion && conclusion !== 'success') console.log(`变异作业结论：${conclusion}；报告可能不完整（命令失败或超时前只写了一部分）`);
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
