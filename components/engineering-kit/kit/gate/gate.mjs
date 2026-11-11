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
  isTestFile,
  loadConfig,
  loadExempt,
  matchesAny,
  recordDir,
  repoFiles,
  repoRoot,
  scopeFiles,
  treeHash,
  writeRecord,
} from './lib.mjs';

/** 判断“这是代码文件”的扩展名（配置文件、文档、脚手架数据不算）。 */
const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|c|cc|cpp|h|swift|sh)$/;

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

    // 尚无源码与测试文件（例如只有脚手架的首次提交）：没有可运行的测试，记录为“无需测试”。
    // 一旦出现源码，上面的测试先行检查就会要求测试，所以跳过这里不会放过未测试的代码。
    if (!repoFiles(root).some((f) => isSourceFile(f, config) || isTestFile(f, config))) {
      // 配置写错（如 JS 项目沿用默认的 src/**/*.ts）时，也会走到这里：有代码文件却没有任何文件匹配 glob，不能当作“无需测试”。
      const stray = scopeFiles(root, config).filter((f) => CODE_FILE.test(f) && !f.startsWith('scripts/engineering/'));
      if (stray.length > 0) {
        return {
          ok: false,
          messages: [`有代码文件但没有任何文件匹配 layout.sourceGlobs / testGlobs，测试不会运行：请检查 engineering.config.json 的 layout.sourceGlobs 与 testGlobs（例：${stray.slice(0, 3).join('、')}）`],
          record: null,
        };
      }
      fs.mkdirSync(recordDir(root), { recursive: true });
      const noTestRecord = {
        passed: true,
        treeHash: treeHash(root, scopeFiles(root, config)),
        command: null,
        skipped: 'no-code',
        exitCode: null,
        changedDuringRun: false,
        log: null,
        sourcesChecked: 0,
        at: new Date().toISOString(),
      };
      writeRecord(root, 'tests.json', noTestRecord);
      return { ok: true, messages: ['尚无源码与测试文件，未运行测试命令（写第一份源码时，测试先行检查会要求先写测试）'], record: noTestRecord };
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
