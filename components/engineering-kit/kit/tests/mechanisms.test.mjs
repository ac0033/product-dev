// 闸门新机制测试（0.6.0）：测试分组与按影响范围测试、结果复用、复审轮次计数与拦截、断言有效性检查、
// pre-push 流程的一致性审与延期、用户接受风险（accept）、只改文档的增量不使代码复审记录过期、结论判定的低级问题。
// 业务含义：闸门要在不降低把关的前提下减少重复劳动（复审每修一次不必重跑全量），并把“审三轮交用户决定”
// “测试要有断言”从文字约定变成机械检查。每组用例对应任务书的一项，在临时 git 仓库里跑真实流程；gh 用假的实现注入。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, normalizeConfig, toFlat, toProfile } from '../gate/config.mjs';
import { ASSERTION_PATTERNS, checkAssertions, countTestCases, hasAssertion } from '../gate/check-assertions.mjs';
import { runGate } from '../gate/gate.mjs';
import { DEPENDENCY_FILES, POLICY_KEYS, loadConfig, parseStatusZ, readRecord, writeRecord } from '../gate/lib.mjs';
import { mergePr } from '../gate/merge.mjs';
import { recordReview, reportVerdict } from '../gate/review.mjs';
import { verify } from '../gate/verify.mjs';
import { commitAll, featureRepo, git, read, reportFile, SRC_HEADER, TEST_CONFIG, tmpRepo, write } from './helpers.mjs';

/** 合格的复审报告正文（不含结论），字数够。 */
const BODY = '发现：无高、中级问题。\n已逐条核对改动的 dedup 函数与测试用例，边界条件（空数组、重复项）均有覆盖，调用方也已核对。\n处置：无需处理。\n';
const PASS_REPORT = `${BODY}## 结论\n通过。无高、中级问题。\n`;
const FAIL_REPORT = `${BODY}## 结论\n不通过。H1 未修复。\n`;

/** 两个测试分组：dedup（源文件与测试）和 rank（一个目录）。 */
const GROUPS = [
  { name: 'dedup', paths: ['src/dedup.ts', 'test/dedup.test.ts'], command: 'node run-dedup.mjs' },
  { name: 'rank', paths: ['src/rank/**', 'test/rank/**'], command: 'node run-rank.mjs' },
];

/**
 * 配了测试分组的功能分支仓库：主干上有全量与各分组的测试脚本（它们只打印自己的名字），当前在 feat。
 * 脚本放在主干上，功能分支的改动不含它们，否则它们自己就成了“不属于任何分组”的改动。
 */
function groupRepo(config = {}) {
  const root = featureRepo({ testCommand: 'node run-full.mjs', testGroups: GROUPS, ...config });
  git(root, ['checkout', '-q', 'main']);
  write(root, 'run-full.mjs', "console.log('RAN-FULL');\n");
  write(root, 'run-dedup.mjs', "console.log('RAN-DEDUP');\n");
  write(root, 'run-rank.mjs', "console.log('RAN-RANK');\n");
  commitAll(root, '测试脚本');
  git(root, ['checkout', '-q', 'feat']);
  git(root, ['rebase', '-q', 'main']);
  return root;
}

/** 在功能分支上改 dedup（源文件与带断言的测试一起改）。 */
function changeDedup(root, tag = 'sorted') {
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return [...new Set(items)].sort(); // ${tag}\n}\n`);
  write(root, 'test/dedup.test.ts', `import { dedup } from '../src/dedup.ts';\nassert.ok(dedup, '${tag}');\n`);
}

/** 这次运行的测试日志。 */
const logOf = (res) => fs.readFileSync(res.record.log, 'utf8');

// ---------- 1. 测试分组与按影响范围测试 ----------

test('测试分组：testGroups 是工作区字段，格式校验；maxReviewRounds 是判定策略字段，默认 3；两种结构互转保留', () => {
  assert.ok(!POLICY_KEYS.includes('testGroups'));
  assert.ok(POLICY_KEYS.includes('maxReviewRounds'));
  assert.equal(DEFAULTS.maxReviewRounds, 3);
  assert.deepEqual(DEFAULTS.testGroups, []);
  const eff = normalizeConfig({ profile: 2, modules: { gate: { testGroups: GROUPS }, review: { maxReviewRounds: 5 } } });
  assert.deepEqual(eff.testGroups, GROUPS);
  assert.equal(eff.maxReviewRounds, 5);
  for (const bad of [
    'x',
    [{ name: 'a', paths: ['src/**'] }],
    [{ name: '', paths: ['src/**'], command: 'x' }],
    [{ name: 'a', paths: [], command: 'x' }],
    [{ name: 'a', paths: [1], command: 'x' }],
    [{ name: 'a', paths: ['src/**'], command: 'x' }, { name: 'a', paths: ['test/**'], command: 'y' }],
  ]) {
    assert.throws(() => normalizeConfig({ profile: 2, modules: { gate: { testGroups: bad } } }), /testGroups/, JSON.stringify(bad));
  }
  for (const bad of [0, 1.5, '3']) assert.throws(() => normalizeConfig({ maxReviewRounds: bad }), /maxReviewRounds/);
  const prof = toProfile({ testGroups: GROUPS, maxReviewRounds: 4 });
  assert.deepEqual(prof.modules.gate.testGroups, GROUPS);
  assert.equal(prof.modules.review.maxReviewRounds, 4);
  assert.equal(toProfile({}).modules.gate.testGroups, undefined, '没有分组时 profile 里不写这一项');
  const flat = toFlat(prof);
  assert.deepEqual(flat.testGroups, GROUPS);
  assert.equal(flat.maxReviewRounds, 4);
});

test('--affected：没有全量通过记录时改跑全量并写明原因；记录带 mode、groups、files、配置摘要', () => {
  const root = groupRepo();
  changeDedup(root);
  const res = runGate({ root, affected: true });
  assert.equal(res.ok, true, res.messages.join('\n'));
  assert.ok(res.messages.some((m) => /改跑全量.*没有可用的全量通过记录/.test(m)), res.messages.join('\n'));
  assert.equal(res.record.mode, 'full');
  assert.deepEqual(res.record.groups, []);
  assert.equal(res.record.fullAt, res.record.treeHash);
  assert.deepEqual(Object.keys(res.record.files).sort(), ['src/dedup.ts', 'test/dedup.test.ts']);
  assert.match(res.record.files['src/dedup.ts'], /^[0-9a-f]{40}$/);
  assert.ok(res.record.configDigest);
  assert.match(logOf(res), /RAN-FULL/);
  assert.deepEqual(readRecord(root, 'tests-full.json'), res.record, '通过的全量记录另存一份，供以后算影响范围');
});

test('--affected：全量之后只改了分组内的文件时，只跑命中的分组；静态检查照常做', () => {
  const root = groupRepo();
  changeDedup(root, 'v1');
  const full = runGate({ root });
  assert.equal(full.ok, true, full.messages.join('\n'));
  changeDedup(root, 'v2');
  const res = runGate({ root, affected: true });
  assert.equal(res.ok, true, res.messages.join('\n'));
  assert.equal(res.record.mode, 'affected');
  assert.deepEqual(res.record.groups, ['dedup']);
  assert.equal(res.record.fullAt, full.record.treeHash);
  const log = logOf(res);
  assert.match(log, /RAN-DEDUP/);
  assert.doesNotMatch(log, /RAN-FULL|RAN-RANK/);
  assert.ok(res.messages.some((m) => m.startsWith('测试先行检查通过')), res.messages.join('\n'));
  assert.ok(res.messages.some((m) => /按影响范围.*dedup/.test(m)), res.messages.join('\n'));
  assert.equal(readRecord(root, 'tests-full.json').treeHash, full.record.treeHash, 'affected 运行不覆盖全量记录');

  // 静态检查两种模式都做：测试改成没有断言，affected 也拦
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nconsole.log(dedup, 'v3');\n");
  const bad = runGate({ root, affected: true });
  assert.equal(bad.ok, false);
  assert.ok(bad.messages.some((m) => /断言/.test(m)), bad.messages.join('\n'));
});

test('--affected：不属于任何分组、配置与套件脚本、依赖清单、基线变化、没有配置分组时改跑全量并写明原因', () => {
  const cases = [
    ['不属于任何分组', (root) => write(root, 'notes.txt', 'x\n')],
    ['配置、豁免表或套件脚本', (root) => write(root, 'scripts/engineering/exempt.json', JSON.stringify({ testFirst: {} }))],
    ['依赖清单或锁文件', (root) => write(root, 'src/rank/package.json', '{}\n')],
  ];
  for (const [why, mutate] of cases) {
    const root = groupRepo({ testGroups: [...GROUPS, { name: 'all-src', paths: ['src/**'], command: 'node run-rank.mjs' }] });
    changeDedup(root, 'v1');
    assert.equal(runGate({ root }).ok, true);
    changeDedup(root, 'v2');
    mutate(root);
    const res = runGate({ root, affected: true });
    assert.equal(res.ok, true, res.messages.join('\n'));
    assert.equal(res.record.mode, 'full', why);
    assert.ok(res.messages.some((m) => m.includes('改跑全量') && m.includes(why)), `${why}：${res.messages.join('\n')}`);
  }

  // 基线变化：主干前进后合入
  const root = groupRepo();
  changeDedup(root, 'v1');
  commitAll(root, 'v1');
  assert.equal(runGate({ root }).ok, true);
  git(root, ['checkout', '-q', 'main']);
  write(root, 'other.txt', 'x\n');
  commitAll(root, 'main 前进');
  git(root, ['checkout', '-q', 'feat']);
  git(root, ['merge', '-q', '--no-edit', 'main']);
  changeDedup(root, 'v2');
  const moved = runGate({ root, affected: true });
  assert.equal(moved.record.mode, 'full');
  assert.ok(moved.messages.some((m) => /改跑全量.*基线/.test(m)), moved.messages.join('\n'));

  // 没有配置分组
  const plain = featureRepo();
  changeDedup(plain);
  const none = runGate({ root: plain, affected: true });
  assert.equal(none.ok, true, none.messages.join('\n'));
  assert.equal(none.record.mode, 'full');
  assert.ok(none.messages.some((m) => /改跑全量.*没有配置测试分组/.test(m)), none.messages.join('\n'));
});

test('--affected：依赖清单常量覆盖常见语言（根目录与子目录都认）', () => {
  for (const f of ['package.json', 'pnpm-lock.yaml', 'yarn.lock', 'requirements-dev.txt', 'pyproject.toml', 'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock']) {
    for (const rel of [f, `sub/${f}`]) assert.ok(DEPENDENCY_FILES.some((g) => path.matchesGlob(rel, g)), rel);
  }
});

test('--affected：全量之后没有任何范围内文件改动时沿用全量记录；带 --force 时改跑全量（L2：force 的含义是重跑）', () => {
  const root = groupRepo();
  changeDedup(root, 'v1');
  const full = runGate({ root });
  assert.equal(full.ok, true);
  assert.ok(runGate({ root, affected: true }).messages.some((m) => /^沿用已有通过记录/.test(m)));
  const res = runGate({ root, affected: true, force: true });
  assert.equal(res.ok, true, res.messages.join('\n'));
  assert.equal(res.record.mode, 'full');
  assert.match(logOf(res), /RAN-FULL/);
  assert.ok(res.messages.some((m) => /改跑全量.*--force/.test(m)), res.messages.join('\n'));
});

// ---------- 2. 结果复用 ----------

test('结果复用：树哈希、基线、模式都匹配时不重跑，输出沿用；--force 重跑；只有 affected 记录时要全量仍重跑；配置摘要不同时重跑', () => {
  const root = groupRepo();
  changeDedup(root, 'v1');
  const first = runGate({ root });
  assert.equal(first.ok, true);
  const again = runGate({ root });
  assert.equal(again.ok, true, again.messages.join('\n'));
  assert.ok(again.messages.some((m) => /^沿用已有通过记录（.*full/.test(m)), again.messages.join('\n'));
  assert.equal(again.record.at, first.record.at, '沿用时不改写记录');
  assert.ok(runGate({ root, affected: true }).messages.some((m) => /^沿用已有通过记录/.test(m)), '要 affected 时全量记录也可沿用');

  const forced = runGate({ root, force: true });
  assert.ok(!forced.messages.some((m) => /沿用/.test(m)), forced.messages.join('\n'));
  assert.notEqual(forced.record.at, first.record.at);

  changeDedup(root, 'v2');
  const aff = runGate({ root, affected: true });
  assert.equal(aff.record.mode, 'affected');
  assert.ok(runGate({ root, affected: true }).messages.some((m) => /^沿用已有通过记录（.*affected/.test(m)));

  // 回到全量时的内容：tests.json 是别的树，但全量记录匹配，沿用并写回 tests.json
  changeDedup(root, 'v1');
  const back = runGate({ root });
  assert.ok(back.messages.some((m) => /^沿用已有通过记录/.test(m)), back.messages.join('\n'));
  assert.equal(readRecord(root, 'tests.json').treeHash, back.record.treeHash);

  changeDedup(root, 'v2');
  assert.equal(runGate({ root, affected: true }).record.mode, 'affected');
  const needFull = runGate({ root });
  assert.equal(needFull.record.mode, 'full');
  assert.ok(!needFull.messages.some((m) => /沿用/.test(m)), '要全量而只有 affected 记录时重跑');

  const rec = readRecord(root, 'tests.json');
  writeRecord(root, 'tests.json', { ...rec, configDigest: 'changed' });
  writeRecord(root, 'tests-full.json', { ...rec, configDigest: 'changed' });
  const digest = runGate({ root });
  assert.ok(!digest.messages.some((m) => /沿用/.test(m)), 'testCommand、testEnv、testGroups 的摘要不同不能复用');
});

test('结果复用：没有配置摘要的旧记录不复用（重跑一次），verify 仍认旧记录（视为全量）', () => {
  const root = featureRepo();
  changeDedup(root);
  commitAll(root, 'feat');
  const g = runGate({ root });
  const old = { ...g.record };
  for (const k of ['mode', 'groups', 'fullAt', 'files', 'configDigest']) delete old[k];
  // 0.5.1 留下的只有旧格式的 tests.json，没有全量记录
  fs.rmSync(path.join(root, '.git', 'engineering-gate', 'tests-full.json'));
  writeRecord(root, 'tests.json', old);
  assert.ok(!runGate({ root }).messages.some((m) => /沿用/.test(m)));
  writeRecord(root, 'tests.json', old);
  assert.equal(recordReview({ root, verdict: 'pass', reviewer: 'general-purpose', reportPath: reportFile(PASS_REPORT) }).ok, true);
  assert.equal(verify({ root }).ok, true, JSON.stringify(verify({ root }).problems));
});

test('verify：pre-push 流程推送要求全量记录（affected 时提示跑一次全量）；pr 流程接受 affected；review.mjs 两种都接受', () => {
  const root = groupRepo();
  changeDedup(root, 'v1');
  assert.equal(runGate({ root }).ok, true);
  changeDedup(root, 'v2');
  commitAll(root, 'feat');
  assert.equal(runGate({ root, affected: true }).record.mode, 'affected');
  const r = recordReview({ root, verdict: 'pass', reviewer: 'general-purpose', reportPath: reportFile(PASS_REPORT) });
  assert.equal(r.ok, true, r.message);
  const res = verify({ root });
  assert.equal(res.ok, false);
  assert.ok(res.problems.some((p) => p.includes('pre-push 流程最终推送前须跑一次全量：gate.mjs')), res.problems.join('\n'));
  assert.equal(runGate({ root }).record.mode, 'full');
  assert.equal(verify({ root }).ok, true, JSON.stringify(verify({ root }).problems));

  const pr = groupRepo({ reviewFlow: 'pr' });
  changeDedup(pr, 'v1');
  assert.equal(runGate({ root: pr }).ok, true);
  changeDedup(pr, 'v2');
  commitAll(pr, 'feat');
  assert.equal(runGate({ root: pr, affected: true }).record.mode, 'affected');
  assert.equal(verify({ root: pr }).ok, true, JSON.stringify(verify({ root: pr }).problems));
});

// ---------- 3. 复审轮次计数与拦截 ----------

/** 登记一次 pre-push 复审。 */
function prePush(root, verdict, extra = {}) {
  const report = verdict === 'pass' ? PASS_REPORT : FAIL_REPORT;
  return recordReview({ root, verdict, reviewer: 'general-purpose', reportPath: reportFile(report), summary: 's', ...extra });
}

test('复审轮次（pre-push）：已有 3 个提交登记过 fail 后，在新提交上再登记 pass 或 fail 被拒；带 --user-decision 放行并写进记录；统计行写明轮次', () => {
  // 0.6.1 起轮次按提交计：三次 fail 分别在三个提交上（原来是同一提交上三次 fail）
  const root = featureRepo();
  changeDedup(root);
  assert.equal(runGate({ root }).ok, true);
  const first = prePush(root, 'fail');
  assert.equal(first.ok, true, first.message);
  assert.match(first.message.split('\n').at(-1), /第 1 轮.*累计登记 1 次.*1 个不同提交/);
  nextCommit(root, 'r2');
  assert.equal(prePush(root, 'fail', { kind: 'consistency' }).ok, true, '两种 kind 合并计数');
  nextCommit(root, 'r3');
  assert.equal(prePush(root, 'fail').ok, true);
  nextCommit(root, 'r4');
  const blocked = prePush(root, 'pass');
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /已审三轮仍需再审：向用户说明剩余问题、原因和已做处置，由用户决定/);
  assert.match(blocked.message, /--user-decision/);
  assert.equal(prePush(root, 'fail').ok, false);
  const allowed = prePush(root, 'pass', { userDecision: '用户在对话中同意再审一轮（2026-11-11）' });
  assert.equal(allowed.ok, true, allowed.message);
  assert.equal(allowed.record.userDecision, '用户在对话中同意再审一轮（2026-11-11）');
  assert.match(allowed.message.split('\n').at(-1), /第 4 轮.*累计登记 4 次/);

  // 别的分支不计入
  git(root, ['checkout', '-q', '-b', 'feat2']);
  assert.equal(prePush(root, 'pass').ok, true, '轮次按分支计');
});

/** 打开的 PR、CI 全过；head 可变（模拟 PR 又推了新提交）。 */
function ghFor(state) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[1] === 'view') {
      const view = {
        state: 'OPEN',
        headRefOid: state.head,
        statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        files: (state.files || ['src/dedup.ts']).map((p) => ({ path: p })),
      };
      return { status: 0, stdout: JSON.stringify(view), stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  gh.calls = calls;
  return gh;
}

/** 登记一次 pr 流程审查。 */
function prReg(root, gh, kind, verdict, extra = {}) {
  if (verdict === 'defer') return recordReview({ root, verdict, pr: '7', kind, gh, reason: '低风险，并入巡检', ...extra });
  const report = verdict === 'pass' ? PASS_REPORT : FAIL_REPORT;
  return recordReview({ root, verdict, pr: '7', kind, gh, reviewer: 'general-purpose', reportPath: reportFile(report), summary: 's', ...extra });
}

test('复审轮次（pr）：每次登记追加 pr/<编号>/log.jsonl，两种 kind 合并计数，上限取基准上的 maxReviewRounds', () => {
  const root = featureRepo({ reviewFlow: 'pr', maxReviewRounds: 2 });
  // 分支把上限改大不生效（判定策略取基准提交上的配置）
  write(root, 'engineering.config.json', JSON.stringify({ ...TEST_CONFIG, reviewFlow: 'pr', maxReviewRounds: 9 }, null, 2));
  assert.equal(loadConfig(root).maxReviewRounds, 2);
  const state = { head: 'a'.repeat(40) };
  const gh = ghFor(state);
  assert.equal(prReg(root, gh, 'code', 'fail').ok, true);
  state.head = 'b'.repeat(40);
  const second = prReg(root, gh, 'consistency', 'fail');
  assert.equal(second.ok, true, second.message);
  assert.match(second.message.split('\n').at(-1), /第 2 轮.*累计登记 2 次.*2 个不同提交/);
  const d = prReg(root, gh, 'consistency', 'defer');
  assert.equal(d.ok, true, '延期不是审查结论，不受上限拦截');
  // 0.6.1 起按提交计：b 已计入第 2 轮，在 b 上登记不拦；拦截针对新的提交 c
  state.head = 'c'.repeat(40);
  const blocked = prReg(root, gh, 'code', 'pass');
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /已审二轮仍需再审/);
  const ok = prReg(root, gh, 'code', 'pass', { userDecision: '用户同意继续（PR #7 评论）' });
  assert.equal(ok.ok, true, ok.message);
  const log = read(root, '.git/engineering-gate/pr/7/log.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((e) => `${e.kind}:${e.verdict}`), ['code:fail', 'consistency:fail', 'consistency:defer', 'code:pass']);
  assert.equal(log.at(-1).userDecision, '用户同意继续（PR #7 评论）');
  assert.equal(JSON.parse(read(root, '.git/engineering-gate/pr/7/code.json')).verdict, 'pass', '单文件记录照旧供 merge 读取');
});

// 轮次按被审内容计（0.6.1）：一轮＝登记过 fail 的一份被审内容（pr 流程是最终提交，pre-push 流程是树哈希加文档内容哈希）；同一份内容上两种 kind 都 fail 只算一轮

const lastLine = (res) => res.message.split('\n').at(-1);

test('轮次按提交（pr）：同一提交两种 kind 都 fail 只算一轮；满 3 个提交后，第 3 个提交补登另一种不拦，第 4 个提交要 --user-decision', () => {
  const root = featureRepo({ reviewFlow: 'pr' });
  const state = { head: 'a'.repeat(40) };
  const gh = ghFor(state);
  assert.equal(prReg(root, gh, 'code', 'fail').ok, true);
  const c1 = prReg(root, gh, 'consistency', 'fail');
  assert.equal(c1.ok, true, c1.message);
  assert.match(lastLine(c1), /第 1 轮（按提交计/, '同一提交上的第二份 fail 不另算一轮');
  state.head = 'b'.repeat(40);
  assert.match(lastLine(prReg(root, gh, 'code', 'fail')), /第 2 轮/);
  state.head = 'c'.repeat(40);
  const third = prReg(root, gh, 'code', 'fail');
  assert.match(lastLine(third), /第 3 轮.*累计登记 4 次.*3 个不同提交/);
  // 第 3 轮的提交已计入：这个提交上还没登记过的一致性审首次登记不受拦截；同一 kind 再登记要 --user-decision（L6，0.6.1 复审后改）
  const sameFail = prReg(root, gh, 'consistency', 'fail');
  assert.equal(sameFail.ok, true, sameFail.message);
  assert.match(lastLine(sameFail), /第 3 轮/);
  assert.equal(prReg(root, gh, 'consistency', 'pass').ok, false, '满上限后同一提交、同一 kind 重新登记要 --user-decision');
  assert.equal(prReg(root, gh, 'code', 'fail').ok, false, '满上限后同一提交上代码复审重登同样要 --user-decision');
  // 第 4 个提交：pass、fail 都要 --user-decision
  state.head = 'd'.repeat(40);
  const blocked = prReg(root, gh, 'code', 'pass');
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /已审三轮仍需再审/);
  assert.equal(prReg(root, gh, 'code', 'fail').ok, false);
  const ok = prReg(root, gh, 'code', 'pass', { userDecision: '用户同意再审一轮（PR #7 评论）' });
  assert.equal(ok.ok, true, ok.message);
  assert.match(lastLine(ok), /第 4 轮/);
});

/** 在功能分支上改一次代码并提交、重跑闸门（得到一个新的提交和与之一致的测试记录）。 */
function nextCommit(root, tag) {
  changeDedup(root, tag);
  commitAll(root, tag);
  assert.equal(runGate({ root }).ok, true);
}

test('轮次按被审内容（pre-push）：同一份内容两种 kind 都 fail 只算一轮；第 3 份内容补登另一种不拦、同 kind 重登被拦；第 4 份内容要 --user-decision', () => {
  const root = featureRepo();
  nextCommit(root, 'r1');
  assert.equal(prePush(root, 'fail').ok, true);
  const c1 = prePush(root, 'fail', { kind: 'consistency' });
  assert.equal(c1.ok, true, c1.message);
  assert.match(lastLine(c1), /第 1 轮（按被审内容计/);
  nextCommit(root, 'r2');
  assert.equal(prePush(root, 'fail').ok, true);
  nextCommit(root, 'r3');
  assert.match(lastLine(prePush(root, 'fail')), /第 3 轮/);
  assert.equal(prePush(root, 'fail', { kind: 'consistency' }).ok, true, '第 3 轮的提交补登另一种 fail 不拦');
  assert.equal(prePush(root, 'pass', { kind: 'consistency' }).ok, false, '满上限后同一份内容、同一 kind 重新登记要 --user-decision（L6）');
  assert.equal(prePush(root, 'pass', { kind: 'consistency', userDecision: '用户同意（对话 2026-11-12）' }).ok, true);
  nextCommit(root, 'r4');
  assert.equal(prePush(root, 'pass').ok, false);
  assert.equal(prePush(root, 'pass', { userDecision: '用户同意再审（对话 2026-11-12）' }).ok, true);
});

test('轮次按被审内容（pre-push 只改文档）：树哈希不变、文档内容变化时每份内容各算一轮', () => {
  const root = featureRepo();
  nextCommit(root, 'base');
  const hashes = new Set();
  for (const n of [1, 2, 3]) {
    if (n > 1) {
      write(root, `docs/note-${n}.md`, `# 说明 ${n}\n`);
      commitAll(root, `docs ${n}`);
    }
    const r = prePush(root, 'fail');
    assert.equal(r.ok, true, r.message);
    hashes.add(r.record.treeHash);
    assert.match(lastLine(r), new RegExp(`第 ${n} 轮`));
  }
  assert.equal(hashes.size, 1, '只改文档时树哈希每轮相同');
  const same = prePush(root, 'fail', { kind: 'consistency' });
  assert.equal(same.ok, true, `第 3 个提交补登一致性审不拦：${same.message}`);
  assert.match(lastLine(same), /第 3 轮/);
  write(root, 'docs/note-4.md', '# 说明 4\n');
  commitAll(root, 'docs 4');
  assert.equal(prePush(root, 'fail').ok, false, '第 4 个提交登记要 --user-decision');
});

// H1（PR #8 首轮复审）：pre-push 按被审内容（树哈希 + 文档内容哈希）计轮次，不按 HEAD：修复留在工作区不提交、或 reset 回旧提交，都绕不过上限

test('轮次按被审内容（H1）：同一 HEAD 上工作区改了三次、各登记 fail 后，第四份内容的登记被拒', () => {
  const root = featureRepo();
  for (const tag of ['w1', 'w2', 'w3']) {
    changeDedup(root, tag);
    assert.equal(runGate({ root }).ok, true);
    const r = prePush(root, 'fail');
    assert.equal(r.ok, true, r.message);
  }
  changeDedup(root, 'w4');
  assert.equal(runGate({ root }).ok, true);
  const blocked = prePush(root, 'fail');
  assert.equal(blocked.ok, false, '同一 HEAD 上第四份内容的 fail 要 --user-decision');
  assert.equal(prePush(root, 'pass').ok, false, '第四份内容的 pass 同样要 --user-decision');
  // reset 回已计入的旧内容：同一 kind 重登也被拦
  changeDedup(root, 'w1');
  assert.equal(runGate({ root }).ok, true);
  assert.equal(prePush(root, 'pass').ok, false, '回到已计入的内容，同一 kind 重新登记要 --user-decision');
});

test('轮次按被审内容（L6）：上限未满时同一内容同一 kind 重新登记不受限；满上限后只放行这份内容上还没登记过的另一种 kind', () => {
  const root = featureRepo();
  changeDedup(root, 'v1');
  assert.equal(runGate({ root }).ok, true);
  assert.equal(prePush(root, 'fail').ok, true);
  const again = prePush(root, 'fail');
  assert.equal(again.ok, true, '上限未满，重新登记不受限');
  assert.match(lastLine(again), /第 1 轮/, '同一份内容重登不另算一轮');
  for (const tag of ['v2', 'v3']) {
    changeDedup(root, tag);
    assert.equal(runGate({ root }).ok, true);
    assert.equal(prePush(root, 'fail').ok, true);
  }
  assert.equal(prePush(root, 'fail').ok, false, '满上限后同一内容同一 kind 重登被拒');
  assert.equal(prePush(root, 'fail', { kind: 'consistency' }).ok, true, '另一种 kind 在这份内容上首次登记放行');
  assert.equal(prePush(root, 'pass', { kind: 'consistency' }).ok, false, '另一种 kind 第二次登记被拒');
  assert.equal(prePush(root, 'accept', { userDecision: '用户接受 H1（对话）' }).ok, true, 'accept 不受拦截');
});

test('轮次按被审内容：仓库尚无提交（headSha 为空）时同样按内容计，第四份内容被拦', () => {
  const root = tmpRepo();
  write(root, 'engineering.config.json', JSON.stringify({ ...TEST_CONFIG, base: 'auto' }, null, 2));
  write(root, 'pass.mjs', 'process.exit(0);\n');
  for (const tag of ['n1', 'n2', 'n3']) {
    changeDedup(root, tag);
    assert.equal(runGate({ root }).ok, true);
    const r = prePush(root, 'fail');
    assert.equal(r.ok, true, r.message);
    assert.equal(r.record.headSha, null);
  }
  changeDedup(root, 'n4');
  assert.equal(runGate({ root }).ok, true);
  assert.equal(prePush(root, 'fail').ok, false);
});

// ---------- 4. 断言有效性 ----------

test('断言痕迹：常见语言的写法都认，没有断言的不认', () => {
  for (const t of [
    "assert.equal(a, 1)", "assert(a)", "expect(a).toBe(1)", "a.should.equal(1)", "t.is(a, 1)", "t.deepEqual(a, b)",
    "    assert a == 1", "with pytest.raises(ValueError):", "self.assertEqual(a, 1)", "require.NoError(t, err)",
    "t.Errorf(\"bad\")", "t.Fatal(err)", "assert_eq!(a, 1);", "assertEquals(1, a);",
  ]) assert.ok(hasAssertion(t), t);
  for (const t of ["console.log(dedup)", "import { dedup } from '../src/dedup.ts';", "def helper():\n    return 1"]) assert.ok(!hasAssertion(t), t);
  assert.ok(ASSERTION_PATTERNS.length >= 8);
  assert.equal(countTestCases("test('a', () => {});\nit('b', () => {});\ndef test_x():\nfunc TestY(t *testing.T) {\ncommit('x')\n"), 4);
});

test('断言检查：本次改动的测试文件没有断言痕迹时静态检查不过；豁免表 assertions 放行；verify 也拦', () => {
  const root = featureRepo();
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return [...new Set(items)].sort();\n}\n`);
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nconsole.log(dedup, 'sorted');\n");
  const res = runGate({ root });
  assert.equal(res.ok, false);
  assert.ok(res.messages.some((m) => /test\/dedup\.test\.ts.*断言/.test(m)), res.messages.join('\n'));
  const v = verify({ root });
  assert.ok(v.problems.some((p) => /test\/dedup\.test\.ts.*断言/.test(p)), v.problems.join('\n'));

  write(root, 'scripts/engineering/exempt.json', JSON.stringify({ testFirst: {}, comments: {}, assertions: { 'test/dedup.test.ts': '冒烟测试：只要能导入即可，由集成测试断言' } }));
  const ok = runGate({ root });
  assert.equal(ok.ok, true, ok.messages.join('\n'));
  assert.ok(ok.messages.some((m) => /^断言检查通过.*豁免 1 个/.test(m)), ok.messages.join('\n'));
  const tpl = JSON.parse(fs.readFileSync(new URL('../templates/exempt.json', import.meta.url), 'utf8'));
  assert.deepEqual(tpl.assertions, {}, '模板豁免表有 assertions 一段');
});

test('断言检查：Python 的 __init__.py 与 conftest.py 落在测试目录里也不查断言', () => {
  const root = featureRepo();
  write(root, 'tests/__init__.py', '');
  write(root, 'tests/conftest.py', 'import pytest\n\n@pytest.fixture\ndef items():\n    return [1, 1]\n');
  write(root, 'tests/test_a.py', 'from pkg import a\n\ndef test_a():\n    a.run()\n');
  const config = { ...TEST_CONFIG, testGlobs: ['tests/**/*.py'] };
  const res = checkAssertions({ root, changed: ['tests/__init__.py', 'tests/conftest.py', 'tests/test_a.py'], config });
  assert.deepEqual(res.problems.map((p) => p.file), ['tests/test_a.py']);
  assert.equal(res.stats.checked, 1);
});

test('测试用例数比基准提交上的同一文件减少时不拦，在输出与记录的 staticChecks 里提示', () => {
  const root = featureRepo();
  git(root, ['checkout', '-q', 'main']);
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\ntest('a', () => assert.ok(dedup));\ntest('b', () => assert.ok(dedup));\ntest('c', () => assert.ok(dedup));\n");
  commitAll(root, '三个用例');
  git(root, ['checkout', '-q', 'feat']);
  git(root, ['rebase', '-q', 'main']);
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\ntest('a', () => assert.ok(dedup));\n");
  const res = runGate({ root });
  assert.equal(res.ok, true, res.messages.join('\n'));
  assert.ok(res.messages.some((m) => /test\/dedup\.test\.ts.*用例.*减少 2 个/.test(m)), res.messages.join('\n'));
  assert.deepEqual(res.record.staticChecks.testCases, [{ file: 'test/dedup.test.ts', before: 3, after: 1, removed: 2 }]);
});

/** 测试文件的公共开头：导入和几行说明，使改名前后的文件足够相似，git 的改名检测能配上对。 */
const CASE_HEAD = `import { dedup } from '../src/dedup.ts';\n${'// 去重测试：覆盖空数组、重复项、顺序保持等边界情况，供改名检测比对相似度。\n'.repeat(6)}`;

/** 主干上的 test/dedup.test.ts 改成 3 个用例（之后的改名、删除都以它为基准），回到 feat 并变基。 */
function threeCases(root) {
  git(root, ['checkout', '-q', 'main']);
  write(root, 'test/dedup.test.ts', `${CASE_HEAD}test('a', () => assert.ok(dedup));\ntest('b', () => assert.ok(dedup));\ntest('c', () => assert.ok(dedup));\n`);
  commitAll(root, '三个用例');
  git(root, ['checkout', '-q', 'feat']);
  git(root, ['rebase', '-q', 'main']);
}

/** 只剩一个用例的测试文件内容（与原文件大体相同，git 能把改名配上对）。 */
const ONE_CASE = `${CASE_HEAD}test('a', () => assert.ok(dedup));\n`;

test('用例数减少（改名）：测试文件 git mv 后用例变少，暂存或已提交都按改名前的文件比较并提示', () => {
  for (const commit of [false, true]) {
    const root = featureRepo();
    threeCases(root);
    git(root, ['mv', 'test/dedup.test.ts', 'test/dedup-renamed.test.ts']);
    write(root, 'test/dedup-renamed.test.ts', `${ONE_CASE}// 改名并删掉两个用例\n`);
    git(root, ['add', '-A']);
    if (commit) commitAll(root, '改名');
    const res = runGate({ root });
    assert.equal(res.ok, true, res.messages.join('\n'));
    const hint = res.messages.find((m) => /用例/.test(m) && /减少 2 个/.test(m));
    assert.ok(hint, `commit=${commit}：${res.messages.join('\n')}`);
    assert.match(hint, /test\/dedup-renamed\.test\.ts/);
    assert.match(hint, /test\/dedup\.test\.ts/, '提示里写明改名前的路径');
    assert.equal(res.record.staticChecks.testCases.length, 1);
    assert.equal(res.record.staticChecks.testCases[0].before, 3);
    assert.equal(res.record.staticChecks.testCases[0].after, 1);
    assert.equal(res.record.staticChecks.testCases[0].from, 'test/dedup.test.ts', '按 git 配上的改名对比较，不是按总数');
    assert.match(hint, /由 test\/dedup\.test\.ts 改名/);
  }
});

test('用例数减少（配不上对）：删除旧测试文件、另写内容不同的新测试文件（或只在工作区 mv、没 git add）时按总数比较并提示', () => {
  // 内容完全不同：git 的改名检测配不上对
  const root = featureRepo();
  threeCases(root);
  fs.rmSync(path.join(root, 'test/dedup.test.ts'));
  write(root, 'test/other.test.ts', "import { dedup } from '../src/dedup.ts';\n// 全新写法\nit('只剩一个', () => expect(dedup([1, 1])).toEqual([1]));\n");
  const res = runGate({ root });
  assert.equal(res.ok, true, res.messages.join('\n'));
  const hint = res.messages.find((m) => /用例/.test(m) && /减少 2 个/.test(m));
  assert.ok(hint, res.messages.join('\n'));
  assert.match(hint, /test\/dedup\.test\.ts/);
  assert.match(hint, /test\/other\.test\.ts/);
  // 只在工作区改名（mv，未 git add）：新路径未跟踪，同样提示
  const root2 = featureRepo();
  threeCases(root2);
  fs.renameSync(path.join(root2, 'test/dedup.test.ts'), path.join(root2, 'test/moved.test.ts'));
  write(root2, 'test/moved.test.ts', ONE_CASE);
  const res2 = runGate({ root: root2 });
  assert.ok(res2.messages.some((m) => /用例/.test(m) && /减少 2 个/.test(m) && m.includes('test/moved.test.ts')), res2.messages.join('\n'));
});

test('用例数（改名对照）：改名后用例数不变或变多时不提示', () => {
  const root = featureRepo();
  threeCases(root);
  git(root, ['mv', 'test/dedup.test.ts', 'test/dedup-renamed.test.ts']);
  const res = runGate({ root });
  assert.equal(res.ok, true, res.messages.join('\n'));
  assert.ok(!res.messages.some((m) => /用例数/.test(m)), res.messages.join('\n'));
  assert.equal(res.record.staticChecks.testCases, undefined);
});

// ---------- 5. pre-push 流程的一致性审与延期 ----------

test('pre-push 一致性审：--kind consistency 只写 log 与 review-consistency.json；defer 须写理由；推送核对不要求它', () => {
  const root = featureRepo();
  changeDedup(root);
  commitAll(root, 'feat');
  assert.equal(runGate({ root }).ok, true);
  const c = prePush(root, 'pass', { kind: 'consistency' });
  assert.equal(c.ok, true, c.message);
  assert.equal(c.record.kind, 'consistency');
  assert.equal(readRecord(root, 'review.json'), null, '一致性审不写代码复审记录');
  assert.equal(readRecord(root, 'review-consistency.json').verdict, 'pass');
  assert.equal(recordReview({ root, verdict: 'defer', kind: 'consistency', reason: ' ' }).ok, false);
  assert.equal(recordReview({ root, verdict: 'defer', kind: 'code', reason: '小改动' }).ok, false, '代码复审不能延期');
  const d = recordReview({ root, verdict: 'defer', kind: 'consistency', reason: '小改动，并入巡检' });
  assert.equal(d.ok, true, d.message);
  assert.equal(readRecord(root, 'review-consistency.json').verdict, 'defer');
  assert.equal(recordReview({ root, verdict: 'pass', kind: 'tests', reviewer: 'general-purpose', reportPath: reportFile(PASS_REPORT) }).ok, false);
  assert.match(recordReview({ root, verdict: 'pass', pr: '7', reviewer: 'general-purpose', reportPath: reportFile(PASS_REPORT) }).message, /--pr/);
  // 推送核对只要求代码复审
  assert.ok(verify({ root }).problems.some((p) => /没有复审记录/.test(p)));
  assert.equal(prePush(root, 'pass').ok, true, '不带 --kind 等同 code（旧用法）');
  assert.equal(readRecord(root, 'review.json').kind, 'code');
  assert.equal(verify({ root }).ok, true, JSON.stringify(verify({ root }).problems));
  const log = read(root, '.git/engineering-gate/reviews/log.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((e) => `${e.kind}:${e.verdict}`), ['consistency:pass', 'consistency:defer', 'code:pass']);
});

// ---------- 6. 用户接受风险 ----------

test('accept（pre-push）：报告须为不通过、须带 --user-decision；推送核对按用户决定接受风险放行；不计轮次、不受上限拦截', () => {
  const root = featureRepo();
  changeDedup(root);
  commitAll(root, 'feat');
  assert.equal(runGate({ root }).ok, true);
  for (let i = 0; i < 3; i++) assert.equal(prePush(root, 'fail').ok, true);
  assert.match(prePush(root, 'accept', { reportPath: reportFile(PASS_REPORT), userDecision: '用户接受' }).message, /不通过/);
  assert.match(prePush(root, 'accept', { userDecision: ' ' }).message, /--user-decision/);
  const a = prePush(root, 'accept', { userDecision: '用户接受 L1、M2，不再修改（对话 2026-11-11）' });
  assert.equal(a.ok, true, a.message);
  assert.equal(a.record.verdict, 'accept');
  assert.equal(a.record.userDecision, '用户接受 L1、M2，不再修改（对话 2026-11-11）');
  assert.match(a.message.split('\n').at(-1), /不计轮次/);
  const v = verify({ root });
  assert.equal(v.ok, true, JSON.stringify(v.problems));
  assert.match(v.note, /按用户决定接受风险放行/);
});

test('accept（pr）：合并入口两种 kind 都认 accept，输出写明按用户决定接受风险放行', () => {
  const root = featureRepo({ reviewFlow: 'pr' });
  const gh = ghFor({ head: 'a'.repeat(40) });
  assert.equal(prReg(root, gh, 'code', 'accept', { userDecision: '用户接受 M1（PR 评论）' }).ok, true);
  const c = prReg(root, gh, 'consistency', 'accept', { userDecision: '用户接受重复描述（PR 评论）' });
  assert.equal(c.ok, true, c.message);
  assert.equal(JSON.parse(read(root, '.git/engineering-gate/pr/7/code.json')).userDecision, '用户接受 M1（PR 评论）');
  const res = mergePr({ root, pr: '7', gh });
  assert.equal(res.ok, true, JSON.stringify(res.problems));
  assert.equal(res.notes.filter((n) => n.includes('按用户决定接受风险放行')).length, 2, res.notes.join('\n'));
});

// ---------- 7. 只改文档的增量不使代码复审记录过期 ----------

test('合并入口：代码复审之后只改了文档时仍认代码复审记录并写明两个提交；有代码改动或算不出差异时过期；一致性审不享受', () => {
  const root = featureRepo({ reviewFlow: 'pr' });
  changeDedup(root);
  commitAll(root, 'feat');
  const a = git(root, ['rev-parse', 'HEAD']).trim();
  const state = { head: a };
  const gh = ghFor(state);
  assert.equal(prReg(root, gh, 'code', 'pass').ok, true);
  assert.equal(prReg(root, gh, 'consistency', 'pass').ok, true);
  write(root, 'docs/04-开发/说明.md', '补充说明\n');
  commitAll(root, 'docs');
  const b = git(root, ['rev-parse', 'HEAD']).trim();
  state.head = b;
  const stale = mergePr({ root, pr: '7', gh });
  assert.equal(stale.ok, false);
  assert.ok(!stale.problems.some((p) => p.startsWith('代码复审记录已过期')), stale.problems.join('\n'));
  assert.ok(stale.problems.some((p) => p.startsWith('一致性审记录已过期')), '一致性审须针对最终提交');
  assert.equal(prReg(root, gh, 'consistency', 'pass').ok, true);
  const ok = mergePr({ root, pr: '7', gh });
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  assert.ok(ok.notes.some((n) => n.includes('沿用') && n.includes(a.slice(0, 12)) && n.includes(b.slice(0, 12))), ok.notes.join('\n'));

  changeDedup(root, 'v2');
  commitAll(root, 'code');
  state.head = git(root, ['rev-parse', 'HEAD']).trim();
  assert.equal(prReg(root, gh, 'consistency', 'pass').ok, true);
  const code = mergePr({ root, pr: '7', gh });
  assert.ok(code.problems.some((p) => p.startsWith('代码复审记录已过期')), code.problems.join('\n'));

  // 本地没有记录里的提交：算不出差异，按过期处理
  const rec = JSON.parse(read(root, '.git/engineering-gate/pr/7/code.json'));
  fs.writeFileSync(`${root}/.git/engineering-gate/pr/7/code.json`, JSON.stringify({ ...rec, headSha: 'c'.repeat(40) }));
  assert.ok(mergePr({ root, pr: '7', gh }).problems.some((p) => p.startsWith('代码复审记录已过期')));
});

// ---------- 8. 上一个 PR 复审留下的低级问题 ----------

test('结论判定：冒号也拆小句；结论词后带括号的不认，提示里说明不要加括号', () => {
  assert.equal(reportVerdict('结论：不通过：H1 未修复。').verdict, 'fail');
  assert.equal(reportVerdict('## 结论\n通过：无高、中级问题。').verdict, 'pass');
  assert.equal(reportVerdict('结论: 通过: 无问题').verdict, 'pass');
  assert.equal(reportVerdict('结论：通过（待 M2 修复后）').verdict, null);
  assert.equal(reportVerdict('## 结论\n\n通过（或 不通过）。一句话理由。').verdict, null);
  const root = featureRepo();
  changeDedup(root);
  assert.equal(runGate({ root }).ok, true);
  const r = prePush(root, 'pass', { reportPath: reportFile(`${BODY}结论：通过（待 M2 修复后）\n`) });
  assert.equal(r.ok, false);
  assert.match(r.message, /括号/);
});

test('基准分支解析不了时，合并入口抛错：不调用 gh、不合并（不按工作区的判定策略放行）', () => {
  const root = featureRepo({ reviewFlow: 'pr', base: 'no-such-branch' });
  const gh = ghFor({ head: 'a'.repeat(40) });
  assert.throws(() => mergePr({ root, pr: '7', gh }), /无法取得基准提交上的判定策略/);
  assert.equal(gh.calls.length, 0, '判定策略取不到时一次 gh 调用都不该有（更不会执行 gh pr merge）');
});

test('基准分支解析不了时，pr 流程的复审登记抛错：不调用 gh、不写任何 PR 审查记录', () => {
  const root = featureRepo({ reviewFlow: 'pr', base: 'no-such-branch' });
  const gh = ghFor({ head: 'a'.repeat(40) });
  assert.throws(() => prReg(root, gh, 'code', 'pass'), /无法取得基准提交上的判定策略/);
  assert.equal(gh.calls.length, 0);
  assert.equal(fs.existsSync(path.join(root, '.git', 'engineering-gate', 'pr')), false, '不应写下 PR 审查记录');
});

// ---------- 0.6.0 首轮复审：改名检测让旧路径从改动列表消失（H1、M1、T1）及低级问题（L1、L2、L4、L5） ----------

/** git mv（先建好目标目录：git mv 不会自动建目录）。 */
function gitMv(root, from, to) {
  fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
  git(root, ['mv', from, to]);
}

/** pr 流程仓库：功能分支上提交一份代码改动 A，登记代码复审与一致性审（都针对 A）。返回 { root, gh, state, a }。 */
function reviewedPr(extra = () => {}) {
  const root = featureRepo({ reviewFlow: 'pr' });
  changeDedup(root);
  extra(root);
  commitAll(root, 'feat');
  const a = git(root, ['rev-parse', 'HEAD']).trim();
  const state = { head: a, files: ['src/dedup.ts', 'test/dedup.test.ts'] };
  const gh = ghFor(state);
  assert.equal(prReg(root, gh, 'code', 'pass').ok, true);
  assert.equal(prReg(root, gh, 'consistency', 'pass').ok, true);
  return { root, gh, state, a };
}

/** 提交一个新增量，PR 最终提交指向它，并对它补登一致性审（一致性审本来就须针对最终提交）。 */
function pushDelta(ctx, mutate) {
  mutate(ctx.root);
  commitAll(ctx.root, 'delta');
  ctx.state.head = git(ctx.root, ['rev-parse', 'HEAD']).trim();
  assert.equal(prReg(ctx.root, ctx.gh, 'consistency', 'pass').ok, true);
  return mergePr({ root: ctx.root, pr: '7', gh: ctx.gh });
}

test('改名（H1）：代码复审后把测试或套件脚本 git mv 到 docs/ 下，不算只改文档，代码复审记录过期', () => {
  for (const [from, to] of [['test/dedup.test.ts', 'docs/04-开发/dedup.test.ts'], ['scripts/engineering/gate/verify.mjs', 'docs/04-开发/verify.mjs']]) {
    const ctx = reviewedPr((root) => write(root, 'scripts/engineering/gate/verify.mjs', '// 闸门脚本：推送核对。\nexport const v = 1;\n'));
    const res = pushDelta(ctx, (root) => gitMv(root, from, to));
    assert.equal(res.ok, false, `${from} → ${to} 被当成只改文档：${JSON.stringify(res)}`);
    assert.ok(res.problems.some((p) => p.startsWith('代码复审记录已过期')), res.problems.join('\n'));
  }
});

test('删除 ALWAYS_IN_SCOPE 文件（豁免表）的增量不算只改文档', () => {
  const ctx = reviewedPr((root) => write(root, 'scripts/engineering/exempt.json', JSON.stringify({ testFirst: {} })));
  const res = pushDelta(ctx, (root) => git(root, ['rm', '-q', 'scripts/engineering/exempt.json']));
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.ok(res.problems.some((p) => p.startsWith('代码复审记录已过期')), res.problems.join('\n'));
});

test('改名（H1）：只把代码 git mv 进 docs/ 的 PR 不被当成只改文档的 PR（gh 的文件列表只给新路径也一样）', () => {
  const root = featureRepo({ reviewFlow: 'pr' });
  gitMv(root, 'src/dedup.ts', 'docs/04-开发/dedup.ts');
  commitAll(root, 'mv');
  const gh = ghFor({ head: git(root, ['rev-parse', 'HEAD']).trim(), files: ['docs/04-开发/dedup.ts'] });
  const res = mergePr({ root, pr: '7', gh });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.ok(res.problems.some((p) => p.includes('缺少代码复审记录')), res.problems.join('\n'));
});

test('只改文档的 PR 以本地差异判定：最终提交在本地且只改文档时不要求审查；本地没有该提交时按含代码处理', () => {
  const root = featureRepo({ reviewFlow: 'pr' });
  write(root, 'docs/04-开发/说明.md', '说明\n');
  commitAll(root, 'docs');
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  assert.equal(mergePr({ root, pr: '7', gh: ghFor({ head, files: ['docs/04-开发/说明.md'] }) }).ok, true);
  const res = mergePr({ root, pr: '7', gh: ghFor({ head: 'd'.repeat(40), files: ['docs/04-开发/说明.md'] }) });
  assert.equal(res.ok, false, 'gh 的列表不再作为只改文档的依据');
  assert.ok(res.problems.some((p) => p.includes('缺少代码复审记录')), res.problems.join('\n'));
});

test('改名（M1）：把一个分组的文件 git mv 到另一个分组后，--affected 两个分组都跑', () => {
  const groups = [
    { name: 'a', paths: ['a/**'], command: 'node run-dedup.mjs' },
    { name: 'b', paths: ['b/**'], command: 'node run-rank.mjs' },
  ];
  const root = groupRepo({ testGroups: groups });
  git(root, ['checkout', '-q', 'main']);
  write(root, 'a/data.txt', '数据\n');
  commitAll(root, 'a');
  git(root, ['checkout', '-q', 'feat']);
  git(root, ['rebase', '-q', 'main']);
  write(root, 'a/note.txt', 'x\n');
  assert.equal(runGate({ root }).ok, true);
  gitMv(root, 'a/data.txt', 'b/data.txt');
  commitAll(root, 'mv');
  const res = runGate({ root, affected: true });
  assert.equal(res.ok, true, res.messages.join('\n'));
  assert.ok(res.record.mode === 'full' || (res.record.groups.includes('a') && res.record.groups.includes('b')), JSON.stringify(res.record.groups));
  assert.ok('a/data.txt' in res.record.files, '改名的旧路径以删除进入范围');
  assert.equal(res.record.files['a/data.txt'], 'deleted');
});

test('L1：同一代码树、同一基线的全量测试上次未通过时，--affected 改跑全量并写明原因', () => {
  const root = groupRepo();
  changeDedup(root, 'v1');
  assert.equal(runGate({ root }).ok, true);
  changeDedup(root, 'v2');
  const aff = runGate({ root, affected: true });
  assert.equal(aff.record.mode, 'affected');
  writeRecord(root, 'tests.json', { ...aff.record, mode: 'full', groups: [], passed: false, exitCode: 1 });
  const res = runGate({ root, affected: true });
  assert.equal(res.record.mode, 'full', res.messages.join('\n'));
  assert.ok(res.messages.some((m) => /改跑全量.*全量测试.*未通过/.test(m)), res.messages.join('\n'));
});

test('L4、L5：断言痕迹补更多写法并排除 require.resolve 等；用例计数不把正则的 .test( 算进去', () => {
  for (const t of ['Assert.AreEqual(1, a);', 'Assert.That(a, Is.EqualTo(1));', 'XCTAssertEqual(a, 1)', 'a shouldBe 1', 'shouldThrow<IllegalStateException> { f() }', 'assert_equal 1, a', 'assert_raises ValueError']) {
    assert.ok(hasAssertion(t), t);
  }
  for (const t of ["const p = require.resolve('x');", 'delete require.cache[k];', 'if (require.main === module) run();']) assert.ok(!hasAssertion(t), t);
  assert.equal(countTestCases("if (/x/.test(s)) {}\nre.test(y);\ntest('a', () => {});\n"), 1);
});

// ---------- 0.6.0 第二轮复核：git status 的改名条目（中级）与 N3 ----------

test('parseStatusZ：暂存的改名与复制，旧路径也作为一项返回（标 from）', () => {
  const entries = parseStatusZ('R  docs/04-开发/evil.md\0src/evil.ts\0C  src/copy.ts\0src/orig.ts\0 M src/a.ts\0?? new.txt\0');
  assert.deepEqual(entries.map((e) => [e.code, e.file, Boolean(e.from)]), [
    ['R ', 'docs/04-开发/evil.md', false],
    ['R ', 'src/evil.ts', true],
    ['C ', 'src/copy.ts', false],
    ['C ', 'src/orig.ts', true],
    [' M', 'src/a.ts', false],
    ['??', 'new.txt', false],
  ]);
});

test('改名（status）：已提交的源文件改动之后只暂存 git mv 进 docs/，推送核对报范围内有未提交的改动', () => {
  const root = featureRepo();
  changeDedup(root);
  commitAll(root, 'feat');
  gitMv(root, 'src/dedup.ts', 'docs/04-开发/dedup.md');
  assert.equal(runGate({ root }).ok, true);
  assert.equal(recordReview({ root, verdict: 'pass', reviewer: 'general-purpose', reportPath: reportFile(PASS_REPORT) }).ok, true);
  const res = verify({ root });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.ok(res.problems.some((p) => /范围内有未提交的改动[\s\S]*src\/dedup\.ts/.test(p)), res.problems.join('\n'));
});

test('N3：本地没有 PR 最终提交而按含代码处理时，输出说明原因并提示先 git fetch', () => {
  const root = featureRepo({ reviewFlow: 'pr' });
  const res = mergePr({ root, pr: '7', gh: ghFor({ head: 'd'.repeat(40) }) });
  assert.equal(res.ok, false);
  assert.ok(res.notes.some((n) => n.includes('本地没有') && n.includes('git fetch')), JSON.stringify(res.notes));
});

// ---------- 0.6.0 第三轮前：最近一次运行的结果说了算（同一棵树上之后的失败不能被更早的通过记录抹掉） ----------

/**
 * 测试命令看一个被 git 忽略的标记文件决定成败：标记文件不在闸门范围内，所以同一棵代码树可以先过后不过（模拟不稳定的测试）。
 * 脚本和 .gitignore 放在主干上；command 用 node flaky.mjs。
 */
function addFlaky(root) {
  git(root, ['checkout', '-q', 'main']);
  write(root, 'flaky.mjs', "import fs from 'node:fs';\nprocess.exit(fs.existsSync('flag.txt') ? 1 : 0);\n");
  write(root, '.gitignore', 'flag.txt\n');
  commitAll(root, 'flaky');
  git(root, ['checkout', '-q', 'feat']);
  git(root, ['rebase', '-q', 'main']);
}

test('复用：全量通过后同一棵树 --force 全量失败，再跑闸门（不带 --force）必须重跑，不沿用更早的通过记录；verify 读到未通过', () => {
  const root = featureRepo({ testCommand: 'node flaky.mjs' });
  addFlaky(root);
  changeDedup(root);
  commitAll(root, 'feat');
  assert.equal(runGate({ root }).ok, true);
  write(root, 'flag.txt', 'x\n');
  const failed = runGate({ root, force: true });
  assert.equal(failed.ok, false, failed.messages.join('\n'));
  assert.ok(verify({ root }).problems.some((p) => /最近一次测试未通过/.test(p)));
  const again = runGate({ root });
  assert.ok(!again.messages.some((m) => /沿用/.test(m)), again.messages.join('\n'));
  assert.equal(again.ok, false, '重跑后仍失败');
  assert.equal(readRecord(root, 'tests.json').passed, false);
  assert.ok(verify({ root }).problems.some((p) => /最近一次测试未通过/.test(p)), 'verify 读到的 tests.json 必须是未通过');
  fs.rmSync(path.join(root, 'flag.txt'));
  const fixed = runGate({ root });
  assert.equal(fixed.ok, true, fixed.messages.join('\n'));
  assert.ok(!fixed.messages.some((m) => /沿用/.test(m)), '失败之后的第一次通过要真的跑出来');
});

test('复用（只测 reusable）：同一棵树上有通过的 tests-full.json、而 tests.json 是未通过时，普通运行与 --affected 都不沿用', () => {
  // 直接写两份记录，不经“全量失败时删除全量记录”那条路径：这条测试单独守住 reusable 里“最近一次运行未通过就不沿用”的判断
  const root = groupRepo();
  changeDedup(root, 'v1');
  commitAll(root, 'feat');
  const pass = runGate({ root });
  assert.equal(pass.ok, true, pass.messages.join('\n'));
  for (const affected of [false, true]) {
    writeRecord(root, 'tests-full.json', { ...pass.record });
    writeRecord(root, 'tests.json', { ...pass.record, passed: false, at: new Date(0).toISOString() });
    const res = runGate({ root, affected });
    assert.ok(!res.messages.some((m) => /沿用/.test(m)), `affected=${affected}：${res.messages.join('\n')}`);
    assert.match(logOf(res), /RAN-FULL/, `affected=${affected}：应当真的重跑全量`);
  }
});

test('复用：分组测试在某棵树上失败后，--affected 与普通运行都不沿用任何通过记录；verify 读到未通过', () => {
  const groups = [{ name: 'dedup', paths: ['src/dedup.ts', 'test/dedup.test.ts'], command: 'node flaky.mjs' }];
  const root = groupRepo({ testGroups: groups });
  addFlaky(root);
  changeDedup(root, 'v1');
  assert.equal(runGate({ root }).ok, true);
  changeDedup(root, 'v2');
  assert.equal(runGate({ root, affected: true }).record.mode, 'affected');
  write(root, 'flag.txt', 'x\n');
  const failed = runGate({ root, affected: true, force: true });
  assert.equal(failed.ok, false, failed.messages.join('\n'));
  assert.equal(failed.record.mode, 'affected');
  const again = runGate({ root, affected: true });
  assert.ok(!again.messages.some((m) => /沿用/.test(m)), again.messages.join('\n'));
  assert.equal(again.ok, false);
  assert.equal(readRecord(root, 'tests.json').passed, false);
  assert.ok(verify({ root }).problems.some((p) => /最近一次测试未通过/.test(p)));
});
