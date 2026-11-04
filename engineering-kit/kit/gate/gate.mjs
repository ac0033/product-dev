// 测试闸门：推送前运行。先做静态检查（测试先行、注释），通过后运行配置的测试命令，
// 把结果连同当前代码树哈希写入记录。业务含义：测试记录只对“跑测试时”的那份代码有效；
// 跑测试期间代码变了，记录作废（树哈希前后不一致）。
// 用法：node scripts/engineering/gate/gate.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { checkComments } from './check-comments.mjs';
import { checkTestFirst } from './check-test-first.mjs';
import {
  acquireLock,
  changedFiles,
  isMain,
  isSourceFile,
  loadConfig,
  loadExempt,
  matchesAny,
  recordDir,
  repoRoot,
  scopeFiles,
  treeHash,
  writeRecord,
} from './lib.mjs';

/**
 * 运行闸门。返回 { ok, messages, record }。
 * 静态检查未通过时直接返回，不运行测试，也不写测试记录。
 */
export function runGate({ root }) {
  const config = loadConfig(root);
  const exempt = loadExempt(root);
  const release = acquireLock(root, config.lockMaxAgeMinutes);
  try {
    const changed = changedFiles(root, config.base);
    const sources = changed.filter((f) => isSourceFile(f, config) && !matchesAny(f, config.reviewIgnore));
    const problems = [
      ...checkTestFirst({ root, changed, config, exempt: exempt.testFirst }),
      ...checkComments({ root, files: sources, config, exempt: exempt.comments }),
    ];
    if (problems.length > 0) {
      return {
        ok: false,
        messages: ['静态检查未通过（未运行测试）：', ...problems.map((p) => `  - ${p.message}`)],
        record: null,
      };
    }

    const before = treeHash(root, scopeFiles(root, config));
    fs.mkdirSync(recordDir(root), { recursive: true });
    const logFile = path.join(recordDir(root), 'tests.log');
    const env = { ...process.env, ...config.testEnv };
    const r = spawnSync(config.testCommand, { cwd: root, shell: true, encoding: 'utf8', env, maxBuffer: 256 * 1024 * 1024 });
    fs.writeFileSync(logFile, `${r.stdout || ''}${r.stderr || ''}`);
    const after = treeHash(root, scopeFiles(root, config));
    const changedDuringRun = before !== after;
    const passed = r.status === 0 && !changedDuringRun;

    const record = {
      passed,
      treeHash: before,
      command: config.testCommand,
      exitCode: r.status,
      changedDuringRun,
      log: logFile,
      sourcesChecked: sources.length,
      at: new Date().toISOString(),
    };
    writeRecord(root, 'tests.json', record);

    const messages = [];
    if (changedDuringRun) messages.push('测试运行期间代码发生了变化，记录作废：请在闸门运行时不要修改代码，然后重跑。');
    messages.push(
      passed
        ? `测试通过（源文件 ${sources.length} 个，日志 ${logFile}）`
        : `测试未通过（退出码 ${r.status}，日志 ${logFile}）`,
    );
    return { ok: passed, messages, record };
  } finally {
    release();
  }
}

if (isMain(import.meta.url)) {
  try {
    const res = runGate({ root: repoRoot() });
    for (const m of res.messages) console.log(m);
    process.exit(res.ok ? 0 : 1);
  } catch (e) {
    console.error(`闸门出错：${e.message}`);
    process.exit(1);
  }
}
