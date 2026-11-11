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
import { DEPENDENCY_FILES, POLICY_KEYS, loadConfig, readRecord, writeRecord } from '../gate/lib.mjs';
import { mergePr } from '../gate/merge.mjs';
import { recordReview, reportVerdict } from '../gate/review.mjs';
import { verify } from '../gate/verify.mjs';
import { commitAll, featureRepo, git, read, reportFile, SRC_HEADER, TEST_CONFIG, write } from './helpers.mjs';

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

test('复审轮次（pre-push）：已有 3 次 fail 后再登记 pass 或 fail 被拒；带 --user-decision 放行并写进记录；统计行写明轮次', () => {
  const root = featureRepo();
  changeDedup(root);
  assert.equal(runGate({ root }).ok, true);
  const first = prePush(root, 'fail');
  assert.equal(first.ok, true, first.message);
  assert.match(first.message.split('\n').at(-1), /第 1 轮.*累计登记 1 次.*1 个不同提交/);
  assert.equal(prePush(root, 'fail', { kind: 'consistency' }).ok, true, '两种 kind 合并计数');
  assert.equal(prePush(root, 'fail').ok, true);
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

test('基准分支解析不了时，合并入口与 pr 流程的复审登记都抛错（不按工作区的判定策略放行）', () => {
  const root = featureRepo({ reviewFlow: 'pr', base: 'no-such-branch' });
  const gh = ghFor({ head: 'a'.repeat(40) });
  assert.throws(() => mergePr({ root, pr: '7', gh }), /无法取得基准提交上的判定策略/);
  assert.throws(() => prReg(root, gh, 'code', 'pass'), /无法取得基准提交上的判定策略/);
  assert.equal(gh.calls.length, 0);
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
