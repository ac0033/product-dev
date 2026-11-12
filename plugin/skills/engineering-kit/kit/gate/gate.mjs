// 测试闸门：推送前运行。先做静态检查（测试先行、注释、断言），通过后运行测试，
// 把结果连同当前代码树哈希和基准提交（基线）写入记录。通过时逐项列出静态检查各查了几个文件，再列测试结果：
// 只打印测试一行，看的人分不清静态检查是通过了还是没有执行。业务含义：测试记录只对“跑测试时”的那份代码、
// 那个基准提交、那份测试配置有效；跑测试期间代码变了，记录作废（树哈希前后不一致）。差异只来自运行期间新出现的未跟踪文件时
// （多半是覆盖率、快照这类测试产物），仍判不通过，但提示列出这些文件并建议加入 .gitignore。
// 两种测试模式：
//   全量（默认）     运行配置的 testCommand。通过的全量记录另存 tests-full.json，记下当时范围内每个文件的内容哈希。
//   按影响范围（--affected）以最近一次通过的全量记录为起点，算出此后改动的文件，只运行命中的测试分组（modules.gate.testGroups）；
//                    没有分组、没有可用的全量记录、基线或测试配置变了、改动不属于任何分组、涉及配置与套件脚本或依赖清单时，
//                    自动改跑全量并写明原因；这份代码上次全量未通过时也改跑全量。全量记录之后没有改动时，通常已在结果复用一步
//                    沿用了全量记录，不会走到分组计划；走到这里只有两种情况——带了 --force，或沿用被最近一次未通过的运行拦住——
//                    这时改跑全量（不能什么都不跑就写通过）。改动文件按 diffNames 取（改名算删除加新增）。
// 结果复用：已有通过的记录且代码树、基线、测试配置摘要（testCommand、testEnv、testGroups）都一致、模式满足要求
//   （要全量时须是全量记录）时不重跑，输出“沿用已有通过记录”；--force 强制重跑。最近一次运行说了算：同一代码树、基线、测试配置上
//   刚有过未通过的运行（全量或分组）时不沿用任何记录，全量未通过时同一棵树的全量通过记录作废。静态检查两种模式、复用与否都照常做。
// 闸门范围的口径见 lib.mjs 的 gateScope；基准分支设置取默认主干上的配置，判定策略（reviewIgnore 等）取基准提交上的配置，
// 工作区写的值与生效值不同时输出提示行。
// 用法：node scripts/engineering/gate/gate.mjs [--affected] [--force]
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checkAssertions, testCaseHintMessages } from './check-assertions.mjs';
import { checkComments } from './check-comments.mjs';
import { checkTestFirst } from './check-test-first.mjs';
import {
  ALWAYS_IN_SCOPE,
  DEPENDENCY_FILES,
  acquireLock,
  fileHashes,
  gateScope,
  git,
  hashOfFiles,
  isIgnoredDoc,
  isMain,
  isSourceFile,
  isTestFile,
  loadConfig,
  loadExempt,
  matchesAny,
  readRecord,
  recordDir,
  repoFiles,
  repoRoot,
  treeHash,
  writeRecord,
} from './lib.mjs';

/** 判断“这是代码文件”的扩展名（配置文件、文档、脚手架数据不算）。 */
const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|c|cc|cpp|h|swift|sh)$/;

/** 最近一次通过的全量记录（按影响范围测试的起点）。tests.json 总是最近一次运行的记录。 */
const FULL_RECORD = 'tests-full.json';

/** 测试先行没能检查的文件（语言不支持）：通过与不通过时的输出都要列出，不让它们被当成“无需测试”。 */
function uncheckedLines(testFirst) {
  return testFirst.unchecked > 0
    ? [`  未检查 ${testFirst.unchecked} 个（语言不支持，识别不了测试引用，不等于无需测试，请自行保证有测试）：${testFirst.uncheckedFiles.join('、')}`]
    : [];
}

/**
 * 静态检查通过后的结果行：各检查了几个本次改动的文件、豁免了几个。三项的范围不同，各自写明：
 * 测试先行看全部改动的源文件，已删除的和没有可测导出的计入“无需测试”；注释检查不看 reviewIgnore 之内的和已删除的；
 * 断言检查看本次改动的测试文件（不含已删除的、reviewIgnore 之内的和 __init__.py、conftest.py）。
 */
function staticMessages({ testFirst, comments }, assertions) {
  return [
    `测试先行检查通过（本次改动的源文件：检查 ${testFirst.checked} 个，豁免 ${testFirst.exempt} 个，无需测试 ${testFirst.skipped} 个，含已删除的）`,
    ...uncheckedLines(testFirst),
    `注释检查通过（本次改动的源文件，不含 reviewIgnore 之内的和已删除的：检查 ${comments.checked} 个，豁免 ${comments.exempt} 个）`,
    `断言检查通过（本次改动的测试文件，不含已删除的、reviewIgnore 之内的和 __init__.py、conftest.py：检查 ${assertions.checked} 个，豁免 ${assertions.exempt} 个）`,
  ];
}

/** 测试配置摘要：testCommand、testEnv、testGroups 任一变了，旧记录都不能复用、也不能当作按影响范围测试的起点。 */
export function configDigest(config) {
  const json = JSON.stringify({ testCommand: config.testCommand, testEnv: config.testEnv, testGroups: config.testGroups });
  return crypto.createHash('sha256').update(json).digest('hex');
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

/** 最多列出前几个文件，其余写“等 N 个”。 */
function listSome(files, n = 5) {
  return files.length <= n ? files.join('、') : `${files.slice(0, n).join('、')} 等 ${files.length} 个`;
}

/**
 * 可以沿用的通过记录：tests.json 或全量记录中，通过、代码树、基线、测试配置摘要都与现在一致，
 * 且模式满足要求（要全量时须是全量记录；要按影响范围时任一通过记录都行）。没有时返回 null。
 * 最近一次运行说了算：tests.json 总是最近一次运行的记录，它是同一代码树、同一基线、同一测试配置上的未通过记录时
 * （全量或分组失败，例如不稳定的测试、带 --force 重跑失败），不沿用任何更早的通过记录。
 */
function reusable(root, { hash, baseRev, digest, affected }) {
  const last = readRecord(root, 'tests.json');
  if (last && !last.passed && last.treeHash === hash && last.base === baseRev && last.configDigest === digest) return null;
  for (const rec of [last, readRecord(root, FULL_RECORD)]) {
    if (!rec || !rec.passed || rec.treeHash !== hash || rec.base !== baseRev || rec.configDigest !== digest) continue;
    if (!affected && rec.mode !== 'full') continue;
    return rec;
  }
  return null;
}

/**
 * 按影响范围测试的计划：返回 { mode: 'full', reason } 或 { mode: 'affected', full, changed, groups }。
 * 改动文件 = 当前范围内文件的内容哈希与全量记录里的不同（新增、修改、删除，以及回到与基准相同而离开范围的）。
 * 另两种改跑全量：tests.json 是这份代码（同一树哈希、同一基线）的全量运行且未通过——手里已有全量失败的反证，
 * 只跑分组会得到与之矛盾的通过记录；全量记录之后没有任何改动——通常复用已经沿用了全量记录、走不到这里，
 * 走到这里只有两种情况：带了 --force（它的含义是重跑，不能什么都不跑就写通过），或沿用被最近一次失败拦住（见 reusable）。
 */
function planAffected(root, config, { files, hash, baseRev, digest, force }) {
  if (!config.testGroups || config.testGroups.length === 0) return { mode: 'full', reason: '没有配置测试分组（modules.gate.testGroups）' };
  const last = readRecord(root, 'tests.json');
  if (last && last.mode === 'full' && !last.passed && last.treeHash === hash && last.base === baseRev) {
    return { mode: 'full', reason: '这份代码（同一代码树、同一基线）上次的全量测试未通过' };
  }
  const full = readRecord(root, FULL_RECORD);
  if (!full || !full.passed || full.mode !== 'full' || !full.files) return { mode: 'full', reason: '没有可用的全量通过记录' };
  if (full.base !== baseRev) return { mode: 'full', reason: '基线（基准提交）与全量记录不同' };
  if (full.configDigest !== digest) return { mode: 'full', reason: '测试命令、环境变量或测试分组与全量记录不同' };
  const keys = [...new Set([...Object.keys(full.files), ...Object.keys(files)])].sort();
  const changed = keys.filter((f) => (full.files[f] ?? 'absent') !== (files[f] ?? 'absent'));
  if (changed.length === 0) return { mode: 'full', reason: force ? '带了 --force，而全量记录之后没有改动：按要求重跑全量' : '全量记录之后没有改动，但没能沿用它：重跑全量' };
  const always = changed.filter((f) => matchesAny(f, ALWAYS_IN_SCOPE));
  if (always.length > 0) return { mode: 'full', reason: `改动涉及配置、豁免表或套件脚本：${listSome(always)}` };
  const deps = changed.filter((f) => matchesAny(f, DEPENDENCY_FILES));
  if (deps.length > 0) return { mode: 'full', reason: `改动涉及依赖清单或锁文件：${listSome(deps)}` };
  const loose = changed.filter((f) => !config.testGroups.some((g) => matchesAny(f, g.paths)));
  if (loose.length > 0) return { mode: 'full', reason: `有改动文件不属于任何分组：${listSome(loose)}` };
  const groups = config.testGroups.filter((g) => changed.some((f) => matchesAny(f, g.paths)));
  return { mode: 'affected', full, changed, groups };
}

/**
 * 运行测试命令（一条或多条，按顺序，遇到失败即停）。返回 { status, log }：status 为第一条失败命令的退出码，全过为 0。
 * 多条命令时日志里每段前面写明分组名和命令。
 */
function runCommands(root, config, commands) {
  const env = { ...process.env, ...config.testEnv };
  let log = '';
  for (const { name, command } of commands) {
    const r = spawnSync(command, { cwd: root, shell: true, encoding: 'utf8', env, maxBuffer: 256 * 1024 * 1024 });
    if (name) log += `== 分组 ${name}：${command} ==\n`;
    log += `${r.stdout || ''}${r.stderr || ''}`;
    if (r.status !== 0) return { status: r.status, log };
  }
  return { status: 0, log };
}

/**
 * 运行闸门。返回 { ok, messages, record }。通过时 messages 先列静态检查，再列测试结果。
 * 静态检查未通过时直接返回，不运行测试，也不写测试记录。记录里的 base 是基准提交，verify 与 review 核对它。
 */
function runChecks({ root, config, affected = false, force = false }) {
  const exempt = loadExempt(root);
  const release = acquireLock(root, config.lockMaxAgeMinutes);
  try {
    const before = gateScope(root, config);
    const { changed, baseRev } = before;
    const sources = changed.filter((f) => isSourceFile(f, config) && !isIgnoredDoc(f, before.reviewIgnore));
    const staticChecks = { testFirst: {}, comments: {} };
    const asserted = checkAssertions({ root, changed, config: { ...config, reviewIgnore: before.reviewIgnore }, exempt: exempt.assertions, baseRev });
    const problems = [
      ...checkTestFirst({ root, changed, config, exempt: exempt.testFirst, stats: staticChecks.testFirst }),
      ...checkComments({ root, files: sources, config, exempt: exempt.comments, stats: staticChecks.comments }),
      ...asserted.problems,
    ];
    const hintLines = testCaseHintMessages(asserted.hints);
    if (problems.length > 0) {
      return {
        ok: false,
        messages: ['静态检查未通过（未运行测试）：', ...problems.map((p) => `  - ${p.message}`), ...uncheckedLines(staticChecks.testFirst), ...hintLines],
        record: null,
      };
    }
    if (asserted.hints.length > 0) staticChecks.testCases = asserted.hints;
    const passLines = [...staticMessages(staticChecks, asserted.stats), ...hintLines];
    const digest = configDigest(config);
    const files = fileHashes(root, before.scope);
    const beforeHash = hashOfFiles(files);

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
        treeHash: beforeHash,
        base: baseRev,
        mode: 'full',
        groups: [],
        fullAt: beforeHash,
        files,
        configDigest: digest,
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
      return { ok: true, messages: [...passLines, '尚无源码与测试文件，未运行测试命令（写第一份源码时，测试先行检查会要求先写测试）'], record: noTestRecord };
    }

    if (!force) {
      const rec = reusable(root, { hash: beforeHash, baseRev, digest, affected });
      if (rec) {
        const cur = readRecord(root, 'tests.json');
        if (!cur || cur.at !== rec.at || cur.treeHash !== rec.treeHash) writeRecord(root, 'tests.json', rec);
        return {
          ok: true,
          messages: [...passLines, `沿用已有通过记录（${rec.at}，${rec.mode}）：代码树、基线和测试配置都与该记录一致，未重跑测试；要重跑加 --force`],
          record: rec,
        };
      }
    }

    const plan = affected ? planAffected(root, config, { files, hash: beforeHash, baseRev, digest, force }) : { mode: 'full' };
    const messages = [...passLines];
    if (plan.reason) messages.push(`改跑全量：${plan.reason}`);
    fs.mkdirSync(recordDir(root), { recursive: true });
    const logFile = path.join(recordDir(root), 'tests.log');
    const base = { treeHash: beforeHash, base: baseRev, mode: plan.mode, files, configDigest: digest, log: logFile, sourcesChecked: sources.length, staticChecks };

    const commands = plan.mode === 'full' ? [{ name: null, command: config.testCommand }] : plan.groups.map((g) => ({ name: g.name, command: g.command }));
    if (plan.mode === 'affected') {
      messages.push(`按影响范围测试：全量记录（${plan.full.treeHash.slice(0, 12)}）之后改动 ${plan.changed.length} 个文件，运行分组 ${plan.groups.map((g) => g.name).join('、')}`);
    }
    const r = runCommands(root, config, commands);
    fs.writeFileSync(logFile, r.log);
    const after = gateScope(root, config);
    const changedDuringRun = beforeHash !== treeHash(root, after.scope) || after.baseRev !== baseRev;
    const passed = r.status === 0 && !changedDuringRun;

    const record = {
      passed,
      ...base,
      groups: plan.mode === 'full' ? [] : plan.groups.map((g) => g.name),
      fullAt: plan.mode === 'full' ? beforeHash : plan.full.treeHash,
      command: commands.map((c) => c.command).join(' && '),
      exitCode: r.status,
      changedDuringRun,
      at: new Date().toISOString(),
    };
    writeRecord(root, 'tests.json', record);
    if (passed && plan.mode === 'full') writeRecord(root, FULL_RECORD, record);
    if (!passed) {
      // 这棵树刚刚没通过：同一代码树、同一基线、同一测试配置的全量通过记录作废（删除），以后既不能沿用它，
      // 也不能拿它当按影响范围测试的起点；否则 tests.json 被别的运行覆盖后，更早的通过会把这次失败抹掉
      const full = readRecord(root, FULL_RECORD);
      if (full && full.treeHash === beforeHash && full.base === baseRev && full.configDigest === digest) {
        fs.rmSync(path.join(recordDir(root), FULL_RECORD), { force: true });
      }
    }

    if (changedDuringRun) {
      const artifacts = after.baseRev === baseRev ? newArtifacts(root, before.scope, beforeHash, after.scope) : [];
      messages.push(
        artifacts.length > 0
          ? `测试运行期间出现了未被 git 忽略的新文件，记录作废：${artifacts.join('、')}。多半是测试产物（覆盖率、快照等）：把它们加入 .gitignore 后重跑闸门；确实要提交的，先提交再重跑。`
          : '测试运行期间代码发生了变化，记录作废：请在闸门运行时不要修改代码，然后重跑。',
      );
    }
    const what = plan.mode === 'full' ? '全量' : `分组 ${record.groups.join('、')}`;
    messages.push(
      passed
        ? `测试通过（${what}，源文件 ${sources.length} 个，日志 ${logFile}）`
        : `测试未通过（${what}，退出码 ${r.status}，日志 ${logFile}）`,
    );
    return { ok: passed, messages, record };
  } finally {
    release();
  }
}

/**
 * 运行闸门（配置只读一次）。affected 为 true 时按影响范围测试，force 为 true 时不沿用已有记录。
 * 工作区配置的 base 或判定策略字段与生效值不同时，在输出最前面加提示行（不算错误）。返回值同 runChecks。
 */
export function runGate({ root, affected = false, force = false }) {
  const config = loadConfig(root);
  const res = runChecks({ root, config, affected, force });
  return config.notes.length > 0 ? { ...res, messages: [...config.notes, ...res.messages] } : res;
}

if (isMain(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    const res = runGate({ root: repoRoot(), affected: argv.includes('--affected'), force: argv.includes('--force') });
    for (const m of res.messages) console.log(m);
    process.exit(res.ok ? 0 : 1);
  } catch (e) {
    console.error(`闸门出错：${e.message}`);
    process.exit(1);
  }
}
