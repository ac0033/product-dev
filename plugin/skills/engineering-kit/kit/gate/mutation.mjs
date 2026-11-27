// 对本次改动的源文件运行项目配置的变异测试，并拉回最终提交的 CI 报告供复审使用。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { defaultGh, isMain, isSourceFile, prNumber, repoRoot } from './lib.mjs';
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

/** 拉回最终提交上最近可用的 mutation-report，成功时打印供复审读取的路径。 */
export function pull({ root, pr, out = path.join(os.tmpdir(), `ek-mutation-${prNumber(pr)}.txt`), gh = defaultGh }) {
  let report;
  readRunArtifacts({ root, pr, artifact: 'mutation-report', gh }, (dir) => {
    if (report === undefined) report = fs.readFileSync(path.join(dir, 'mutation-report.txt'));
  });
  if (report === undefined) console.log('本 PR 的 CI 没有变异测试产物（没配置、没带风险标签或作业没跑）');
  else {
    fs.writeFileSync(out, report);
    console.log(`变异测试报告：${path.resolve(out)}`);
  }
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
