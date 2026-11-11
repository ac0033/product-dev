// 测试闸门：推送前运行。先做静态检查（测试先行、注释），通过后运行配置的测试命令，
// 把结果连同当前代码树哈希和基准提交（基线）写入记录。通过时逐项列出两项静态检查各查了几个文件，再列测试结果：
// 只打印测试一行，看的人分不清静态检查是通过了还是没有执行。业务含义：测试记录只对“跑测试时”的那份代码、
// 那个基准提交有效；跑测试期间代码变了，记录作废（树哈希前后不一致）。差异只来自运行期间新出现的未跟踪文件时
// （多半是覆盖率、快照这类测试产物），仍判不通过，但提示列出这些文件并建议加入 .gitignore。
// 闸门范围的口径见 lib.mjs 的 gateScope（reviewIgnore 取基准提交上的配置）。
// 用法：node scripts/engineering/gate/gate.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { checkComments } from './check-comments.mjs';
import { checkTestFirst } from './check-test-first.mjs';
import {
  acquireLock,
  gateScope,
  git,
  isIgnoredDoc,
  isMain,
  isSourceFile,
  isTestFile,
  loadConfig,
  loadExempt,
  recordDir,
  repoFiles,
  repoRoot,
  treeHash,
  writeRecord,
} from './lib.mjs';

/** 判断“这是代码文件”的扩展名（配置文件、文档、脚手架数据不算）。 */
const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|c|cc|cpp|h|swift|sh)$/;

/**
 * 两项静态检查通过后的结果行：各检查了几个本次改动的源文件、豁免了几个。两项的范围不同，各自写明：
 * 测试先行看全部改动的源文件，已删除的和没有可测导出的计入“无需测试”；注释检查不看 reviewIgnore 之内的和已删除的。
 */
function staticMessages({ testFirst, comments }) {
  return [
    `测试先行检查通过（本次改动的源文件：检查 ${testFirst.checked} 个，豁免 ${testFirst.exempt} 个，无需测试 ${testFirst.skipped} 个，含已删除的）`,
    `注释检查通过（本次改动的源文件，不含 reviewIgnore 之内的和已删除的：检查 ${comments.checked} 个，豁免 ${comments.exempt} 个）`,
  ];
}

/**
 * 测试运行期间范围里新出现、且未被 git 跟踪的文件；只有当这些文件是前后差异的唯一来源
 * （运行前范围内的文件内容都没变）时才返回它们，否则返回空数组（按普通的“代码变化”处理）。
 */
function newArtifacts(root, beforeScope, beforeHash, afterScope) {
  const had = new Set(beforeScope);
  const extra = afterScope.filter((f) => !had.has(f));
  if (extra.length === 0) return [];
  const untracked = new Set(git(root, ['ls-files', '--others', '--exclude-standard']).out.split('\n').map((s) => s.trim()).filter(Boolean));
  if (!extra.every((f) => untracked.has(f))) return [];
  return treeHash(root, beforeScope) === beforeHash ? extra : [];
}

/**
 * 运行闸门。返回 { ok, messages, record }。通过时 messages 先列两项静态检查，再列测试结果。
 * 静态检查未通过时直接返回，不运行测试，也不写测试记录。记录里的 base 是基准提交，verify 与 review 核对它。
 */
export function runGate({ root }) {
  const config = loadConfig(root);
  const exempt = loadExempt(root);
  const release = acquireLock(root, config.lockMaxAgeMinutes);
  try {
    const before = gateScope(root, config);
    const { changed, baseRev } = before;
    const sources = changed.filter((f) => isSourceFile(f, config) && !isIgnoredDoc(f, before.reviewIgnore));
    const staticChecks = { testFirst: {}, comments: {} };
    const problems = [
      ...checkTestFirst({ root, changed, config, exempt: exempt.testFirst, stats: staticChecks.testFirst }),
      ...checkComments({ root, files: sources, config, exempt: exempt.comments, stats: staticChecks.comments }),
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
      const stray = before.scope.filter((f) => CODE_FILE.test(f) && !f.startsWith('scripts/engineering/'));
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
        treeHash: treeHash(root, before.scope),
        base: baseRev,
        command: null,
        skipped: 'no-code',
        exitCode: null,
        changedDuringRun: false,
        log: null,
        sourcesChecked: 0,
        staticChecks,
        at: new Date().toISOString(),
      };
      writeRecord(root, 'tests.json', noTestRecord);
      return { ok: true, messages: [...staticMessages(staticChecks), '尚无源码与测试文件，未运行测试命令（写第一份源码时，测试先行检查会要求先写测试）'], record: noTestRecord };
    }

    const beforeHash = treeHash(root, before.scope);
    fs.mkdirSync(recordDir(root), { recursive: true });
    const logFile = path.join(recordDir(root), 'tests.log');
    const env = { ...process.env, ...config.testEnv };
    const r = spawnSync(config.testCommand, { cwd: root, shell: true, encoding: 'utf8', env, maxBuffer: 256 * 1024 * 1024 });
    fs.writeFileSync(logFile, `${r.stdout || ''}${r.stderr || ''}`);
    const after = gateScope(root, config);
    const changedDuringRun = beforeHash !== treeHash(root, after.scope) || after.baseRev !== baseRev;
    const passed = r.status === 0 && !changedDuringRun;

    const record = {
      passed,
      treeHash: beforeHash,
      base: baseRev,
      command: config.testCommand,
      exitCode: r.status,
      changedDuringRun,
      log: logFile,
      sourcesChecked: sources.length,
      staticChecks,
      at: new Date().toISOString(),
    };
    writeRecord(root, 'tests.json', record);

    const messages = staticMessages(staticChecks);
    if (changedDuringRun) {
      const artifacts = after.baseRev === baseRev ? newArtifacts(root, before.scope, beforeHash, after.scope) : [];
      messages.push(
        artifacts.length > 0
          ? `测试运行期间出现了未被 git 忽略的新文件，记录作废：${artifacts.join('、')}。多半是测试产物（覆盖率、快照等）：把它们加入 .gitignore 后重跑闸门；确实要提交的，先提交再重跑。`
          : '测试运行期间代码发生了变化，记录作废：请在闸门运行时不要修改代码，然后重跑。',
      );
    }
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
