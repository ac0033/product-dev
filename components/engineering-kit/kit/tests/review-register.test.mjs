// 复审登记集成测试：真实 git 临时仓库加假 gh，覆盖 S1–S10、H3、H7、A15（登记锁）、0.10.1 的 L1–L6（锁争用与残留）、C1–C6（新旧锁兼容）、S1–S4（pre-push 从被审提交取快照）与合并入口对覆盖的要求。
// 复审者交回的是 ek-review/1 JSON；拒绝路径一律断言没有写任何记录（PR 的 log.jsonl 与 <kind>.json）。不访问网络。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runGate } from '../gate/gate.mjs';
import * as LIB from '../gate/lib.mjs';
import { gateScope, loadConfig, readRecord, treeHash, withLock, withPrLock } from '../gate/lib.mjs';
import { mergePr } from '../gate/merge.mjs';
import { compactFindings, fingerprint } from '../gate/review-data.mjs';
import { recordReview } from '../gate/review.mjs';
import { commitAll, failingData, featureRepo, finding, git, read, reviewData, reviewDataFile, SRC_HEADER, tmpDir, write } from './helpers.mjs';

const GREEN = [
  { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { __typename: 'StatusContext', context: 'lint', state: 'SUCCESS' },
];

/** 假的 gh：pr view 返回给定最终提交的打开状态 PR，其余命令成功；调用记在 calls 里。 */
function fakeGh(head) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[1] === 'view') return { status: 0, stdout: JSON.stringify({ state: 'OPEN', headRefOid: head, statusCheckRollup: GREEN }), stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  gh.calls = calls;
  return gh;
}

/** pr 流程的功能分支仓库，返回 { root, main }：main 是分叉点（基准分支的提交号）。 */
function prRepo(config = {}) {
  const root = featureRepo({ reviewFlow: 'pr', reviewMinChars: 0, ...config });
  return { root, main: git(root, ['rev-parse', 'main']).trim() };
}

/** 在功能分支上再提交一个真实提交，返回提交号。 */
function addCommit(root, n) {
  write(root, `src/f${n}.ts`, `${SRC_HEADER}export const v${n} = ${n};\n`);
  commitAll(root, `c${n}`);
  return git(root, ['rev-parse', 'HEAD']).trim();
}

/** pr 流程的复审数据：被审提交 head、基准 base。 */
const data = (head, base, over = {}) => reviewData({ reviewedCommit: head, reviewedBase: base, ...over });
const failData = (head, base, over = {}) => failingData({ reviewedCommit: head, reviewedBase: base, ...over });
const GAPS = {
  functions: { status: 'verified', note: '每个功能点都有测试。' },
  layers: { status: 'verified', note: '单元与集成层都有。' },
  boundaries: { status: 'verified', note: '空数组与重复项覆盖。' },
};

/** 登记：PR 7 的复审；gh 的最终提交取 opts.prHead（默认数据里的被审提交）。 */
function reg(root, d, { verdict, kind = 'code', prHead, ...extra } = {}) {
  const gh = fakeGh(prHead ?? d.reviewedCommit);
  return recordReview({ root, verdict: verdict ?? d.verdict, reviewer: 'feature-dev:code-reviewer', reportPath: reviewDataFile(d), summary: 's', pr: '7', kind, gh, ...extra });
}

const prDir = (root) => path.join(root, '.git', 'engineering-gate', 'pr', '7');
const logLines = (root) => {
  const f = path.join(prDir(root), 'log.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).length : 0;
};
const hasRecord = (root, kind = 'code') => fs.existsSync(path.join(prDir(root), `${kind}.json`));
const latest = (root, kind = 'code') => JSON.parse(read(root, `.git/engineering-gate/pr/7/${kind}.json`));
/** 断言拒绝且没有写任何记录（相对 before 行数不变，且 <kind>.json 状态不变）。 */
function assertRejected(root, r, pattern, before = { lines: 0, code: false }) {
  assert.equal(r.ok, false, JSON.stringify(r));
  if (pattern) assert.match(r.message, pattern);
  assert.equal(logLines(root), before.lines, '拒绝时不追加历史');
  assert.equal(hasRecord(root), before.code, '拒绝时不写最新记录');
}

test('S5 登记 pass：记录有 risk、reviewedBase、coverage full、dataSha、findings、数据副本和 Markdown 报告', () => {
  const { root, main } = prRepo();
  const head = addCommit(root, 1);
  const d = data(head, main, { findings: [finding({ id: 'L1', severity: 'low', files: ['src/dedup.ts'] })] });
  const r = reg(root, d);
  assert.equal(r.ok, true, r.message);
  const rec = latest(root);
  assert.equal(rec.verdict, 'pass');
  assert.equal(rec.headSha, head);
  assert.equal(rec.risk, 'low');
  assert.equal(rec.reviewedBase, main);
  assert.equal(rec.coverage, 'full');
  assert.equal(rec.dataSha, fingerprint(d));
  assert.deepEqual(rec.findings, compactFindings(d.findings));
  assert.ok(rec.data && fs.existsSync(rec.data), '数据副本存在');
  assert.equal(JSON.parse(fs.readFileSync(rec.data, 'utf8')).format, 'ek-review/1');
  assert.ok(rec.report && rec.report.endsWith('.md') && fs.existsSync(rec.report), '报告是生成的 .md');
  assert.ok(!fs.readFileSync(rec.report, 'utf8').trimStart().startsWith('{'), '报告不是 JSON');
  assert.equal(logLines(root), 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(prDir(root), 'log.jsonl'), 'utf8').trim()).coverage, 'full', '历史行也带 coverage');
  assert.equal(readRecord(root, 'review.json'), null, 'pr 流程不写工作区的 review.json');
});

test('S1 报告文件是 Markdown 或坏 JSON 时拒绝并提示 JSON，不写任何记录', () => {
  const { root } = prRepo();
  const head = addCommit(root, 1);
  const md = '## 范围\n读了。\n## 发现\n无\n## 作者的验证\n核对了。\n结论\n通过\n';
  for (const text of [md, '{ 坏的 json', '[]', '"str"', '']) {
    const r = recordReview({ root, verdict: 'pass', reviewer: 'feature-dev:code-reviewer', reportPath: reviewDataFile(text), summary: 's', pr: '7', kind: 'code', gh: fakeGh(head) });
    assertRejected(root, r, text === md || text.startsWith('{') ? /JSON/ : undefined);
  }
});

test('S2 数据不合格（多出字段、缺必需节、高级发现缺触发条件）：拒绝并逐条列出，不写记录', () => {
  const { root, main } = prRepo();
  const head = addCommit(root, 1);
  const cases = [
    [data(head, main, { extra: 1 }), /extra/],
    [data(head, main, { sections: { 范围: '读了。' } }), /作者的验证/],
    [failData(head, main, { findings: [finding({ severity: 'high', trigger: '' })] }), /第 1 条发现.*trigger/],
    [data(head, main, { verdict: 'pass', findings: [finding()] }), /M1/],
  ];
  for (const [d, pattern] of cases) assertRejected(root, reg(root, d), pattern);
});

test('S2 数据里的 files 在被审提交和基准里都不存在：拒绝并列出；存在则放行', () => {
  const { root, main } = prRepo();
  const head = addCommit(root, 1);
  const bad = data(head, main, { findings: [finding({ id: 'L1', severity: 'low', files: ['src/ghost.ts'] })] });
  assertRejected(root, reg(root, bad), /src\/ghost\.ts/);
  const good = data(head, main, { findings: [finding({ id: 'L1', severity: 'low', files: ['src/f1.ts'] })] });
  assert.equal(reg(root, good).ok, true);
});

test('H3 数据的被审提交是旧提交、PR 已前进到新提交：拒绝并写明两个提交，不写记录', () => {
  const { root, main } = prRepo();
  const oldHead = addCommit(root, 1);
  const newHead = addCommit(root, 2);
  const r = reg(root, data(oldHead, main), { prHead: newHead });
  assertRejected(root, r);
  assert.ok(r.message.includes(oldHead.slice(0, 12)) && r.message.includes(newHead.slice(0, 12)), r.message);
  // 对新提交审查则放行
  assert.equal(reg(root, data(newHead, main), { prHead: newHead }).ok, true);
});

test('H7 基准是 PR 中间的提交：pass 拒绝（不写记录），fail 允许且记录 partial；这份 partial 的 fail 不能当覆盖链', () => {
  const { root, main } = prRepo();
  const a = addCommit(root, 1);
  addCommit(root, 2);
  const c = addCommit(root, 3);
  const pass = reg(root, data(c, a));
  assertRejected(root, pass, /覆盖|部分/);
  const fail = reg(root, failData(c, a));
  assert.equal(fail.ok, true, fail.message);
  assert.equal(latest(root).coverage, 'partial');
  assert.equal(latest(root).reviewedBase, a);
  assert.equal(logLines(root), 1);
  // partial 的 fail 登记过也不算覆盖：同一基准的 pass 仍然拒绝，历史行数不变
  assertRejected(root, reg(root, data(c, a)), /覆盖|部分/, { lines: 1, code: true });
  // 基准等于被审提交同样是部分覆盖
  assertRejected(root, reg(root, data(c, c)), /覆盖|部分/, { lines: 1, code: true });
  // 对完整范围（基准是分叉点）审查则放行；因为 c 上已有 fail 登记，不需要处置（同一提交）
  assert.equal(reg(root, data(c, main)).ok, true);
});

test('H7 覆盖链：先在提交 A 完整登记 fail，再在 B 上以 reviewedBase=A 登记 pass，允许且 coverage 为 full', () => {
  const { root, main } = prRepo();
  const a = addCommit(root, 1);
  const f = reg(root, failData(a, main));
  assert.equal(f.ok, true, f.message);
  assert.equal(latest(root).coverage, 'full');
  const b = addCommit(root, 2);
  const fixed = { id: 'M1', status: 'fixed', evidence: '补了空数组判断，见 src/f2.ts。' };
  const r = reg(root, data(b, a, { dispositions: [fixed] }));
  assert.equal(r.ok, true, r.message);
  assert.equal(latest(root).coverage, 'full');
  assert.equal(latest(root).reviewedBase, a);
  // 覆盖链按种类分开：一致性审在 B 上用 A 作基准，A 上没有一致性审的完整登记，拒绝
  const cons = reg(root, data(b, a, { kind: 'consistency' }), { kind: 'consistency' });
  assert.equal(cons.ok, false);
  assert.match(cons.message, /覆盖|部分/);
});

test('H7 基准不是被审提交的祖先：pass 拒绝', () => {
  const { root, main } = prRepo();
  const a = addCommit(root, 1);
  git(root, ['checkout', '-q', '-b', 'side', main]);
  const other = addCommit(root, 9);
  git(root, ['checkout', '-q', 'feat']);
  const r = reg(root, data(a, other));
  assertRejected(root, r);
  assert.ok(r.message.length > 0);
});

test('H7 合并入口：代码复审记录是 partial 或缺 coverage（旧记录）时拒绝合并并写明部分覆盖，都是 full 才合并', () => {
  const setup = () => {
    const { root, main } = prRepo();
    const head = addCommit(root, 1);
    assert.equal(reg(root, data(head, main)).ok, true);
    assert.equal(reg(root, data(head, main, { kind: 'consistency' }), { kind: 'consistency' }).ok, true);
    return { root, head };
  };
  const rewrite = (root, kind, fn) => {
    const f = path.join(prDir(root), `${kind}.json`);
    const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
    fn(rec);
    fs.writeFileSync(f, JSON.stringify(rec, null, 2));
  };
  for (const [name, fn] of [['partial', (r) => { r.coverage = 'partial'; }], ['缺 coverage', (r) => { delete r.coverage; }]]) {
    for (const kind of ['code', 'consistency']) {
      const { root, head } = setup();
      rewrite(root, kind, fn);
      const gh = fakeGh(head);
      const res = mergePr({ root, pr: '7', gh });
      assert.equal(res.ok, false, `${kind} ${name}`);
      assert.ok(res.problems.some((p) => /部分/.test(p)), `${kind} ${name}：${res.problems.join(' / ')}`);
      assert.equal(gh.calls.some((a) => a[1] === 'merge'), false, '拒绝时不调用 gh pr merge');
    }
  }
  const { root, head } = setup();
  const gh = fakeGh(head);
  const res = mergePr({ root, pr: '7', gh });
  assert.equal(res.ok, true, JSON.stringify(res.problems));
  assert.deepEqual(gh.calls.at(-1), ['pr', 'merge', '7', '--squash', '--match-head-commit', head, '--delete-branch']);
});

test('S6 风险高：缺 --evidence-checked 拒绝（不写记录），带了成功且记录里有 evidenceChecked', () => {
  const { root, main } = prRepo();
  const head = addCommit(root, 1);
  const d = data(head, main, { risk: 'high', testGaps: GAPS });
  assertRejected(root, reg(root, d), /evidence-checked|核对/);
  assertRejected(root, reg(root, d, { evidenceChecked: '  ' }), /evidence-checked|核对/);
  const text = '主对话重跑了新增测试，核对了空数组和重复项两个边界用例。';
  const r = reg(root, d, { evidenceChecked: text });
  assert.equal(r.ok, true, r.message);
  assert.equal(latest(root).evidenceChecked, text);
  assert.equal(latest(root).risk, 'high');
  // 高风险数据缺 testGaps：拒绝（这一份换新仓库，避免被前面的记录干扰）
  const other = prRepo();
  const h2 = addCommit(other.root, 1);
  assertRejected(other.root, reg(other.root, data(h2, other.main, { risk: 'high' }), { evidenceChecked: '核对了。' }), /testGaps/);
});

test('S7 风险档位不降：先登记 high 的 fail，再登记 low 的 pass 被拒，high 的 pass 放行', () => {
  const { root, main } = prRepo();
  const head = addCommit(root, 1);
  const hf = failData(head, main, { risk: 'high', testGaps: GAPS });
  assert.equal(reg(root, hf, { evidenceChecked: '核对了测试缺口。' }).ok, true);
  assert.equal(logLines(root), 1);
  assertRejected(root, reg(root, data(head, main, { risk: 'low' })), /风险/, { lines: 1, code: true });
  assert.equal(latest(root).verdict, 'fail', '最新记录没被低风险的 pass 覆盖');
  const hp = data(head, main, { risk: 'high', testGaps: GAPS });
  assert.equal(reg(root, hp, { evidenceChecked: '核对了测试缺口。' }).ok, true);
});

test('S8 修后复核：A 登记 fail（含 M1），B 上登记 pass 没有 dispositions 拒绝，带 fixed 处置成功', () => {
  const { root, main } = prRepo();
  const a = addCommit(root, 1);
  assert.equal(reg(root, failData(a, main)).ok, true);
  const b = addCommit(root, 2);
  assertRejected(root, reg(root, data(b, a)), /M1/, { lines: 1, code: true });
  const ok = reg(root, data(b, a, { dispositions: [{ id: 'M1', status: 'fixed', evidence: '补了空数组判断。' }] }));
  assert.equal(ok.ok, true, ok.message);
  assert.equal(logLines(root), 2);
  assert.equal(latest(root).verdict, 'pass');
});

test('S8 未修好的处置：pass 里带 not-fixed 拒绝；fail 里 not-fixed 须有 prior 发现指向', () => {
  const { root, main } = prRepo();
  const a = addCommit(root, 1);
  assert.equal(reg(root, failData(a, main)).ok, true);
  const b = addCommit(root, 2);
  const notFixed = { id: 'M1', status: 'not-fixed', evidence: '没改。' };
  assertRejected(root, reg(root, data(b, a, { dispositions: [notFixed] })), undefined, { lines: 1, code: true });
  const noPointer = failData(b, a, { findings: [finding({ id: 'M2' })], dispositions: [notFixed] });
  assertRejected(root, reg(root, noPointer), /M1/, { lines: 1, code: true });
  const pointed = failData(b, a, { findings: [finding({ id: 'M2', prior: 'M1' })], dispositions: [notFixed] });
  const r = reg(root, pointed);
  assert.equal(r.ok, true, r.message);
  assert.equal(logLines(root), 2);
});

test('S10 历史里有坏 JSON 的行：登记报错并带文件与行号，不放行、不写记录', () => {
  const { root, main } = prRepo();
  const head = addCommit(root, 1);
  fs.mkdirSync(prDir(root), { recursive: true });
  const logFile = path.join(prDir(root), 'log.jsonl');
  const good = { pr: '7', kind: 'consistency', verdict: 'defer', headSha: head, at: '2026-11-26T00:00:00.000Z' };
  const broken = `${JSON.stringify(good)}\n这不是 JSON\n`;
  fs.writeFileSync(logFile, broken);
  let message;
  try {
    const r = reg(root, data(head, main));
    assert.equal(r.ok, false, '不能放行');
    message = r.message;
  } catch (e) {
    message = e.message;
  }
  assert.match(message, /log\.jsonl:2/);
  assert.equal(hasRecord(root), false, '不写最新记录');
  assert.equal(fs.readFileSync(logFile, 'utf8'), broken, '历史文件原样保留');
  // 不是对象的行同样报错
  fs.writeFileSync(logFile, '[1,2]\n');
  let again;
  try {
    again = reg(root, data(head, main)).message;
  } catch (e) {
    again = e.message;
  }
  assert.match(again, /log\.jsonl:1/);
  assert.equal(hasRecord(root), false);
});

test('A15 登记锁：持锁期间再登记同一 PR 报“登记锁被占用”，不写记录；锁释放后能登记；锁内读写互不干扰', () => {
  const { root, main } = prRepo();
  const head = addCommit(root, 1);
  let during;
  const out = withPrLock(root, '7', () => {
    try {
      during = reg(root, data(head, main)).message;
    } catch (e) {
      during = e.message;
    }
    return 42;
  });
  assert.equal(out, 42, 'withPrLock 返回 fn 的结果');
  assert.match(during, /登记锁被占用/);
  assert.equal(hasRecord(root), false);
  assert.equal(logLines(root), 0);
  const after = reg(root, data(head, main));
  assert.equal(after.ok, true, after.message);
  // fn 抛错时也释放锁
  assert.throws(() => withPrLock(root, '7', () => { throw new Error('boom'); }), /boom/);
  assert.equal(withPrLock(root, '7', () => 'again'), 'again');
  // 不同 PR 的锁互不影响
  withPrLock(root, '7', () => assert.equal(withPrLock(root, '8', () => 'other'), 'other'));
});

/** pre-push 流程的仓库，改了源码并跑过闸门（有与当前代码一致的通过测试记录）。 */
function prePushRepo() {
  const root = featureRepo({ reviewMinChars: 0 });
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return [...new Set(items)].sort();\n}\n`);
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nassert.ok(dedup, 'sorted');\n");
  assert.equal(runGate({ root }).ok, true);
  return root;
}
const prePush = (root, d, extra = {}) => recordReview({ root, verdict: d.verdict, reviewer: 'feature-dev:code-reviewer', reportPath: reviewDataFile(d), summary: 's', ...extra });

test('S5 pre-push 流程：JSON 报告照常登记，不给被审范围时不核对覆盖，记录带 risk、dataSha、findings', () => {
  const root = prePushRepo();
  const d = reviewData({ findings: [finding({ id: 'L1', severity: 'low' })] });
  const r = prePush(root, d);
  assert.equal(r.ok, true, r.message);
  const rec = readRecord(root, 'review.json');
  assert.equal(rec.verdict, 'pass');
  assert.equal(rec.risk, 'low');
  assert.equal(rec.dataSha, fingerprint(d));
  assert.deepEqual(rec.findings, compactFindings(d.findings));
  assert.ok(rec.report && fs.existsSync(rec.report));
  // 给了被审范围（外部复审一定给）就核对完整覆盖：仓库里不存在的范围不能登记通过（PR #42 一致性审 M1）
  const root2 = prePushRepo();
  const r2 = prePush(root2, reviewData({ reviewedCommit: 'c'.repeat(40), reviewedBase: 'd'.repeat(40) }));
  assert.equal(r2.ok, false, r2.message);
  assert.match(r2.message, /覆盖/);
});

test('H7 pre-push 流程：被审范围从 HEAD 之前的中间提交开始（只审后段差异）时不能登记通过；从分叉点开始可以（PR #42 一致性审 M1）', () => {
  const root = prePushRepo();
  const fork = git(root, ['merge-base', 'main', 'HEAD']).trim();
  commitAll(root, 'first half');
  const mid = git(root, ['rev-parse', 'HEAD']).trim();
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {
  return [...new Set(items)].sort().reverse();
}
`);
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nassert.ok(dedup, 'later');\n");
  commitAll(root, 'later');
  const g = runGate({ root });
  assert.equal(g.ok, true, JSON.stringify(g.problems ?? g.message ?? g));
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const narrow = prePush(root, reviewData({ reviewedCommit: head, reviewedBase: mid }));
  assert.equal(narrow.ok, false, narrow.message);
  assert.match(narrow.message, /覆盖/);
  const full = prePush(root, reviewData({ reviewedCommit: head, reviewedBase: fork }));
  assert.equal(full.ok, true, full.message);
});

test('S2 pre-push 流程：发现定位到功能分支上已提交删除的文件（只在分叉点的树里）时照常登记（PR #42 代码复审 M4）', () => {
  const root = prePushRepo();
  git(root, ['rm', '-q', '-f', 'src/dedup.ts']);
  commitAll(root, 'drop dedup');
  assert.equal(runGate({ root }).ok, true);
  const r = prePush(root, failingData({ findings: [finding({ files: ['src/dedup.ts'] })] }), { verdict: 'fail' });
  assert.equal(r.ok, true, r.message);
});

test('H7 pre-push 流程：被审范围的终点不是当前 HEAD 时不能登记通过；只给基准或只给终点时拒绝；没给范围但列了未交给复审者的文件也只算部分覆盖（PR #42 第 2 轮代码 M3、一致性 M4）', () => {
  const root = prePushRepo();
  const fork = git(root, ['merge-base', 'main', 'HEAD']).trim();
  commitAll(root, 'first half');
  const mid = git(root, ['rev-parse', 'HEAD']).trim();
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {
  return [...new Set(items)].sort().reverse();
}
`);
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nassert.ok(dedup, 'later');\n");
  commitAll(root, 'later');
  assert.equal(runGate({ root }).ok, true);
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const stale = prePush(root, reviewData({ reviewedCommit: mid, reviewedBase: fork }));
  assert.equal(stale.ok, false, '审的是较早的提交，HEAD 上的后续改动没审');
  assert.match(stale.message, /HEAD/);
  for (const range of [{ reviewedCommit: head, reviewedBase: null }, { reviewedCommit: null, reviewedBase: fork }]) {
    const half = prePush(root, reviewData(range));
    assert.equal(half.ok, false, JSON.stringify(range));
    assert.match(half.message, /同时给出/);
  }
  const hidden = prePush(root, reviewData({ unreviewedFiles: ['src/dedup.ts'] }));
  assert.equal(hidden.ok, false);
  assert.match(hidden.message, /没有交给复审者/);
  const full = prePush(root, reviewData({ reviewedCommit: head, reviewedBase: fork }));
  assert.equal(full.ok, true, full.message);
});

test('S2 pre-push 流程：发现定位到分叉后新增、又在显式基准之后删除的文件（只在 reviewedBase 的树里）时照常登记（PR #42 第 2 轮代码 M4）', () => {
  const root = prePushRepo();
  write(root, 'src/temp.ts', `${SRC_HEADER}export const t = 1;\n`);
  commitAll(root, 'add temp');
  const base = git(root, ['rev-parse', 'HEAD']).trim();
  git(root, ['rm', '-q', '-f', 'src/temp.ts']);
  commitAll(root, 'drop temp');
  assert.equal(runGate({ root }).ok, true);
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const r = prePush(root, failingData({ reviewedCommit: head, reviewedBase: base, findings: [finding({ files: ['src/temp.ts'] })] }), { verdict: 'fail' });
  assert.equal(r.ok, true, r.message);
});

test('H7 覆盖接续：登记历史里没有结构化数据副本的旧版“完整覆盖”记录不作接续依据，从它起审只算部分覆盖（PR #42 第 2 轮代码 M1、一致性 M3）', () => {
  const { root, main } = prRepo();
  const head1 = addCommit(root, 1);
  assert.equal(reg(root, data(head1, main)).ok, true);
  // 模拟旧版（0.9.0 之前）的登记：记录里没有数据副本和指纹
  const log = path.join(prDir(root), 'log.jsonl');
  const old = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map(({ dataSha, data: copy, report, ...r }) => r);
  fs.writeFileSync(log, old.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const head2 = addCommit(root, 2);
  const chained = reg(root, data(head2, head1));
  assert.equal(chained.ok, false, '旧记录的完整覆盖无法证明，不能接续');
  assert.match(chained.message, /缺少同种审查的完整覆盖/);
  assert.equal(reg(root, data(head2, main)).ok, true, '从分叉点补审可以');
});

test('H7 覆盖接续：记录带数据指纹、但没写按新规则判定覆盖（coverageRule）的，同样不作接续依据；新登记都写上（PR #42 最后一轮代码 M3）', () => {
  const { root, main } = prRepo();
  const head1 = addCommit(root, 1);
  const first = reg(root, data(head1, main));
  assert.equal(first.ok, true);
  assert.ok(first.record.coverageRule >= 2, '新登记写明覆盖规则版本');
  const log = path.join(prDir(root), 'log.jsonl');
  const stripped = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map(({ coverageRule, ...r }) => r);
  fs.writeFileSync(log, stripped.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const head2 = addCommit(root, 2);
  const chained = reg(root, data(head2, head1));
  assert.equal(chained.ok, false);
  assert.match(chained.message, /缺少同种审查的完整覆盖/);
});

test('H7 pre-push 流程：复审给了被审范围（审的是提交），工作区却还有未提交的闸门范围内改动时不能登记通过（dsh 同步复审代码 H1）', () => {
  const root = prePushRepo();
  const fork = git(root, ['merge-base', 'main', 'HEAD']).trim();
  commitAll(root, 'reviewed');
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {
  return [...new Set(items)].sort().reverse();
}
`);
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nassert.ok(dedup, 'unreviewed');\n");
  assert.equal(runGate({ root }).ok, true);
  const dirty = prePush(root, reviewData({ reviewedCommit: head, reviewedBase: fork }));
  assert.equal(dirty.ok, false, '未提交的改动没经过复审');
  assert.match(dirty.message, /未提交/);
  commitAll(root, 'now committed');
  assert.equal(runGate({ root }).ok, true);
  const head2 = git(root, ['rev-parse', 'HEAD']).trim();
  const clean = prePush(root, reviewData({ reviewedCommit: head2, reviewedBase: fork }));
  assert.equal(clean.ok, true, clean.message);
});

test('合并入口：代码复审的最新记录与登记历史的最后一条不一致时拒绝合并（上次登记写到一半失败；PR #42 双审 M2/M4）', () => {
  const { root, main } = prRepo();
  const head = addCommit(root, 1);
  for (const kind of ['code', 'consistency']) assert.equal(reg(root, data(head, main, { kind }), { kind }).ok, true);
  // 模拟：历史追加了一条新的 fail，最新记录没来得及替换
  const log = path.join(prDir(root), 'log.jsonl');
  const last = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').filter((l) => JSON.parse(l).kind === 'code').at(-1));
  fs.appendFileSync(log, `${JSON.stringify({ ...last, verdict: 'fail', at: new Date(Date.now() + 1000).toISOString() })}\n`);
  const gh = fakeGh(head);
  const res = mergePr({ root, pr: '7', gh });
  assert.equal(res.ok, false);
  assert.ok(res.problems.some((p) => /不一致/.test(p)), res.problems.join(' / '));
  assert.ok(!gh.calls.some((a) => a[1] === 'merge'));
});

test('S2 pre-push 流程：数据不合格或是 Markdown 时拒绝且不写记录；pre-push 不做 S7（高风险 fail 后低风险 pass 放行）', () => {
  const root = prePushRepo();
  const md = prePush(root, reviewData(), { reportPath: reviewDataFile('## 范围\n读了。\n结论\n通过\n') });
  assert.equal(md.ok, false);
  assert.match(md.message, /JSON/);
  const bad = prePush(root, reviewData({ extra: 1 }));
  assert.equal(bad.ok, false);
  assert.match(bad.message, /extra/);
  assert.equal(readRecord(root, 'review.json'), null, '拒绝时不写记录');
  const hf = prePush(root, failingData({ risk: 'high', testGaps: GAPS }), { evidenceChecked: '核对了测试缺口。' });
  assert.equal(hf.ok, true, hf.message);
  assert.equal(readRecord(root, 'review.json').risk, 'high');
  const lp = prePush(root, reviewData({ risk: 'low' }));
  assert.equal(lp.ok, true, lp.message);
});

/** 把锁直接设成某个持有者（git 引用指向记着持有者的对象），模拟别的进程持锁或崩溃后留下的锁。 */
function setLock(root, name, owner) {
  const sha = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: owner, encoding: 'utf8' }).stdout.trim();
  git(root, ['update-ref', `refs/engineering-gate/locks/${name}`, sha]);
}
const lockRef = (root, name) => spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/engineering-gate/locks/${name}`], { cwd: root, encoding: 'utf8' }).stdout.trim();
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

test('L4 登记锁：错误带 code：持有者活着是 EK_LOCK_BUSY，读不出是 EK_LOCK_BROKEN（0.10.1 代码 M4、一致性 M4；原 A15）。持有者进程还活着时不回收；已不在时回收；持有者信息读不出时不回收并提示手动删除；释放后引用删除（PR #42 双审 M1/M3、PR #43 代码 H2）', () => {
  const { root } = prRepo();
  setLock(root, 'pr-7', JSON.stringify({ pid: process.pid, startedAt: '2000-01-01T00:00:00.000Z', token: 'live' }));
  assert.throws(() => withPrLock(root, '7', () => 1), (e) => /登记锁被占用/.test(e.message) && e.code === 'EK_LOCK_BUSY');
  setLock(root, 'pr-7', JSON.stringify({ pid: deadPid(), startedAt: '2000-01-01T00:00:00.000Z', token: 'dead' }));
  assert.equal(withPrLock(root, '7', () => 42), 42);
  assert.equal(lockRef(root, 'pr-7'), '', '释放后引用删除');
  setLock(root, 'pr-7', 'not json');
  assert.throws(() => withPrLock(root, '7', () => 1), (e) => /登记锁被占用[\s\S]*update-ref -d/.test(e.message) && e.code === 'EK_LOCK_BROKEN');
});

test('L5 登记锁：四个进程同时取锁（开始时留着一把失效锁要回收），只有 code 为 EK_LOCK_BUSY 或 EK_LOCK_CONTENDED 的错误算正常争用，其余重抛；临界区不重叠、全部退出码 0（0.10.1 代码 M4、一致性 M4；原 A15 多进程）', async () => {
  const { root } = prRepo();
  setLock(root, 'pr-7', JSON.stringify({ pid: deadPid(), startedAt: '2000-01-01T00:00:00.000Z', token: 'old' }));
  const dir = tmpDir('ekit-lock-');
  const log = path.join(dir, 'log.txt');
  const worker = path.join(dir, 'worker.mjs');
  const lib = new URL('../gate/lib.mjs', import.meta.url).href;
  fs.writeFileSync(worker, [
    "import fs from 'node:fs';",
    `import { withPrLock } from ${JSON.stringify(lib)};`,
    'const [root, log, id] = process.argv.slice(2);',
    'const until = Date.now() + 3000;',
    'let held = 0;',
    'while (Date.now() < until) {',
    '  try {',
    '    withPrLock(root, "7", () => {',
    '      fs.appendFileSync(log, "E " + id + "\\n");',
    '      const t = Date.now() + 15; while (Date.now() < t) {}',
    '      fs.appendFileSync(log, "X " + id + "\\n");',
    '      held++;',
    '    });',
    '  } catch (e) { if (e.code !== "EK_LOCK_BUSY" && e.code !== "EK_LOCK_CONTENDED") throw e; }',
    '}',
    'process.stdout.write(String(held));',
  ].join('\n'));
  const runs = await Promise.all(Array.from({ length: 4 }, (_, i) => new Promise((resolve) => {
    const p = spawn(process.execPath, [worker, root, log, String(i)]);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  })));
  for (const r of runs) assert.equal(r.code, 0, r.err);
  const total = runs.reduce((n, r) => n + Number(r.out), 0);
  assert.ok(total > 0, '至少有一次取到锁');
  let inside = null;
  for (const line of fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)) {
    const [op, id] = line.split(' ');
    if (op === 'E') { assert.equal(inside, null, `进程 ${id} 进入时 ${inside} 还在临界区里`); inside = id; }
    else { assert.equal(inside, id); inside = null; }
  }
  assert.equal(lockRef(root, 'pr-7'), '', '全部结束后锁已释放');
});

const commonDir = (root) => path.resolve(root, git(root, ['rev-parse', '--git-common-dir']).trim());
/** git 自己的引用锁文件：<引用>.lock。 */
const refLockFile = (root, name) => path.join(commonDir(root), 'refs', 'engineering-gate', 'locks', `${name}.lock`);
const touchRefLock = (root, name) => {
  const file = refLockFile(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  return file;
};
const hoursAgo = (n) => new Date(Date.now() - n * 3600 * 1000);

test('L1 git 的引用锁文件 pr-7.lock 刚建：在 retryMs 内取不到，抛 EK_LOCK_CONTENDED，信息含“暂时取不到”和锁文件路径，锁文件原样保留（0.10.1 代码 M4、一致性 M4）', () => {
  const { root } = prRepo();
  const file = touchRefLock(root, 'pr-7');
  assert.throws(() => withPrLock(root, '7', () => 1, { retryMs: 200 }), (e) => e.code === 'EK_LOCK_CONTENDED' && /暂时取不到/.test(e.message) && e.message.includes('pr-7.lock'));
  assert.ok(fs.existsSync(file), '引用锁文件一律不自动删除');
});

test('L2 引用锁文件存在很久、也没有活着的本套件进程在改：不自动删除，报 EK_LOCK_CONTENDED，写明可能是残留和要人工删除的文件；人工删除后照常取锁（PR #46 第 2 轮决定：撤掉自动删除）', () => {
  const { root } = prRepo();
  const file = touchRefLock(root, 'pr-7');
  fs.utimesSync(file, hoursAgo(5), hoursAgo(5));
  assert.throws(() => withPrLock(root, '7', () => 1, { retryMs: 200 }), (e) => e.code === 'EK_LOCK_CONTENDED' && /没有活着的本套件进程/.test(e.message) && /手动删除/.test(e.message) && e.message.includes('pr-7.lock'));
  assert.ok(fs.existsSync(file), '锁文件一律不自动删除');
  fs.rmSync(file);
  assert.equal(withPrLock(root, '7', () => 5), 5, '人工删除后照常取锁');
  assert.equal(lockRef(root, 'pr-7'), '', '释放后锁引用删除');
});

test('L3 残留的引用锁文件挡住登记和合并时如实报错、不登记不合并；人工删除后两者照常（PR #46 第 2 轮决定：撤掉自动删除）', () => {
  const { root, main } = prRepo();
  const head = addCommit(root, 1);
  const file = touchRefLock(root, 'pr-7');
  fs.utimesSync(file, hoursAgo(1), hoursAgo(1));
  assert.throws(() => reg(root, data(head, main)), /暂时取不到/);
  const gh0 = fakeGh(head);
  assert.throws(() => mergePr({ root, pr: '7', gh: gh0 }), /暂时取不到/);
  assert.equal(gh0.calls.some((c) => c[1] === 'merge'), false, '没有执行合并');
  fs.rmSync(file);
  assert.equal(reg(root, data(head, main)).ok, true);
  assert.equal(reg(root, data(head, main, { kind: 'consistency' }), { kind: 'consistency' }).ok, true);
  const gh = fakeGh(head);
  const m = mergePr({ root, pr: '7', gh });
  assert.equal(m.ok, true, JSON.stringify(m.problems));
  assert.deepEqual(gh.calls.at(-1), ['pr', 'merge', '7', '--squash', '--match-head-commit', head, '--delete-branch']);
});

test('L6 临界区里别的进程建了新的 pr-7.lock、释放不了：有界重试后写 stderr 警告（含“没有释放”），fn 的返回值照常返回（0.10.1 代码 M4、一致性 M4）', () => {
  const { root } = prRepo();
  const warnings = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { warnings.push(String(chunk)); return true; };
  let out;
  try {
    out = withPrLock(root, '7', () => { touchRefLock(root, 'pr-7'); return 3; }, { retryMs: 200 });
  } finally {
    process.stderr.write = original;
  }
  assert.equal(out, 3);
  assert.match(warnings.join(''), /没有释放/);
  fs.rmSync(refLockFile(root, 'pr-7'), { force: true });
});

// ---------- 0.10.1：新旧版本的锁兼容（代码 M7） ----------

/** 0.9.x 的 PR 锁：目录 <git 公共目录>/engineering-gate/pr/<编号>/lock，里面 owner.json 写 { pid, startedAt, token }。 */
const dirLockOf = (root, pr = '7') => path.join(commonDir(root), 'engineering-gate', 'pr', String(pr), 'lock');
function makeDirLock(root, owner) {
  const dir = dirLockOf(root);
  fs.mkdirSync(dir, { recursive: true });
  if (owner) fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify(owner));
  return dir;
}
/** 一个活着的外部进程（持有旧版目录锁的“别的进程”）。 */
function liveChild() {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
}

test('C1 旧版目录锁存在且 owner.json 的 pid 是活着的进程：withPrLock 抛 EK_LOCK_BUSY（含“被占用”），并释放已取到的引用锁（0.10.1 代码 M7）', () => {
  const { root } = prRepo();
  const child = liveChild();
  try {
    const dir = makeDirLock(root, { pid: child.pid, startedAt: new Date().toISOString(), token: 'old' });
    assert.throws(() => withPrLock(root, '7', () => 1), (e) => e.code === 'EK_LOCK_BUSY' && /被占用/.test(e.message));
    assert.equal(lockRef(root, 'pr-7'), '', '引用锁已释放');
    assert.ok(fs.existsSync(dir), '别人持有的目录锁不动');
  } finally {
    child.kill();
  }
});

test('C2 旧版目录锁的持有进程已不在：回收后 fn 执行；结束后目录锁和引用锁都不在（0.10.1 代码 M7）', () => {
  const { root } = prRepo();
  const dir = makeDirLock(root, { pid: deadPid(), startedAt: '2000-01-01T00:00:00.000Z', token: 'dead' });
  assert.equal(withPrLock(root, '7', () => 'ran'), 'ran');
  assert.equal(fs.existsSync(dir), false, '目录锁已释放');
  assert.equal(lockRef(root, 'pr-7'), '', '引用锁已释放');
});

test('C3 临界区内两把锁都持有：旧版目录锁存在且 owner.json 的 pid 是本进程（0.10.1 代码 M7）', () => {
  const { root } = prRepo();
  let seen = null;
  withPrLock(root, '7', () => {
    const dir = dirLockOf(root);
    seen = { exists: fs.existsSync(dir), pid: JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8')).pid, ref: lockRef(root, 'pr-7') };
  });
  assert.equal(seen.exists, true);
  assert.equal(seen.pid, process.pid);
  assert.notEqual(seen.ref, '', '引用锁也在');
});

test('C4 旧版目录锁没有 owner.json：不论多久都算占用（EK_LOCK_BUSY），写明人工确认后删除，不按年龄删（PR #46 第 3 轮代码 H1）', () => {
  const { root } = prRepo();
  const dir = makeDirLock(root, null);
  assert.throws(() => withPrLock(root, '7', () => 1), (e) => e.code === 'EK_LOCK_BUSY' && /被占用/.test(e.message));
  assert.equal(lockRef(root, 'pr-7'), '');
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(dir, old, old);
  assert.throws(() => withPrLock(root, '7', () => 1), (e) => e.code === 'EK_LOCK_BUSY' && /手动删除/.test(e.message));
  assert.ok(fs.existsSync(dir), '认不出持有者的目录锁不自动删除');
  fs.rmSync(dir, { recursive: true });
  assert.equal(withPrLock(root, '7', () => 'ran'), 'ran');
});

test('C6 风险登记锁（withLock risk-register）不建旧版目录锁：fn 内 pr 目录下没有 lock（0.10.1 代码 M7）', () => {
  const { root } = prRepo();
  let found = null;
  withLock(root, 'risk-register', () => {
    const prRoot = path.join(commonDir(root), 'engineering-gate', 'pr');
    found = fs.existsSync(prRoot) ? fs.readdirSync(prRoot).filter((n) => fs.existsSync(path.join(prRoot, n, 'lock'))) : [];
  });
  assert.deepEqual(found, []);
  assert.equal(fs.existsSync(dirLockOf(root)), false);
});

test('C5 四个进程争用同一个 PR 锁：两个用新版 withPrLock，两个用测试里内嵌的 0.9.x 目录锁算法，写同一份出入日志，临界区不重叠、全部退出码 0（0.10.1 代码 M7）', async () => {
  const { root } = prRepo();
  const common = commonDir(root);
  const dir = tmpDir('ekit-lock-');
  const log = path.join(dir, 'log.txt');
  const lib = new URL('../gate/lib.mjs', import.meta.url).href;
  const newWorker = path.join(dir, 'new.mjs');
  fs.writeFileSync(newWorker, [
    "import fs from 'node:fs';",
    `import { withPrLock } from ${JSON.stringify(lib)};`,
    'const [root, log, id] = process.argv.slice(2);',
    'const until = Date.now() + 3000;',
    'let held = 0;',
    'while (Date.now() < until) {',
    '  try {',
    '    withPrLock(root, "7", () => {',
    '      fs.appendFileSync(log, "E " + id + "\\n");',
    '      const t = Date.now() + 15; while (Date.now() < t) {}',
    '      fs.appendFileSync(log, "X " + id + "\\n");',
    '      held++;',
    '    });',
    '  } catch (e) { if (e.code !== "EK_LOCK_BUSY" && e.code !== "EK_LOCK_CONTENDED") throw e; }',
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);',
    '}',
    'process.stdout.write(String(held));',
  ].join('\n'));
  // 0.9.x 的目录锁：mkdir 建 lock、里面 owner.json；失效 = pid 已不在，或没写成 owner.json 且目录超过 10 分钟；回收用同级 reclaim 目录互斥
  const oldWorker = path.join(dir, 'old.mjs');
  fs.writeFileSync(oldWorker, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    'const [common, log, id] = process.argv.slice(2);',
    "const base = path.join(common, 'engineering-gate', 'pr', '7');",
    "const lock = path.join(base, 'lock');",
    "const reclaim = path.join(base, 'reclaim');",
    'const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };',
    'const stale = () => {',
    '  try { return !alive(JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")).pid); }',
    '  catch { try { return Date.now() - fs.statSync(lock).mtimeMs > 600000; } catch { return false; } }',
    '};',
    'function acquire() {',
    '  fs.mkdirSync(base, { recursive: true });',
    '  for (let i = 0; i < 2; i++) {',
    '    try {',
    '      fs.mkdirSync(lock);',
    '      fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token: id }));',
    '      return true;',
    '    } catch (e) { if (e.code === "EPERM" || e.code === "EACCES") return false; if (e.code !== "EEXIST") throw e; }',
    '    if (!stale()) return false;',
    '    try { fs.mkdirSync(reclaim); } catch (e) { if (["EEXIST", "EPERM", "EACCES"].includes(e.code)) return false; throw e; }',
    '    try { if (stale()) fs.rmSync(lock, { recursive: true, force: true }); } finally { fs.rmSync(reclaim, { recursive: true, force: true }); }',
    '  }',
    '  return false;',
    '}',
    'const until = Date.now() + 3000;',
    'let held = 0;',
    'while (Date.now() < until) {',
    '  if (acquire()) {',
    '    fs.appendFileSync(log, "E " + id + "\\n");',
    '    const t = Date.now() + 15; while (Date.now() < t) {}',
    '    fs.appendFileSync(log, "X " + id + "\\n");',
    '    held++;',
    '    fs.rmSync(lock, { recursive: true, force: true });',
    '  }',
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);',
    '}',
    'process.stdout.write(String(held));',
  ].join('\n'));
  const jobs = [[newWorker, root, 'n0'], [newWorker, root, 'n1'], [oldWorker, common, 'o0'], [oldWorker, common, 'o1']];
  const runs = await Promise.all(jobs.map(([script, where, id]) => new Promise((resolve) => {
    const p = spawn(process.execPath, [script, where, log, id]);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  })));
  for (const r of runs) assert.equal(r.code, 0, r.err);
  assert.ok(Number(runs[0].out) + Number(runs[1].out) > 0, '新版一组至少进过一次临界区（PR #46 第 1 轮一致性 M7）');
  assert.ok(Number(runs[2].out) + Number(runs[3].out) > 0, '旧版一组至少进过一次临界区（PR #46 第 1 轮一致性 M7）');
  let inside = null;
  for (const line of fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)) {
    const [op, id] = line.split(' ');
    if (op === 'E') { assert.equal(inside, null, `进程 ${id} 进入时 ${inside} 还在临界区里`); inside = id; }
    else { assert.equal(inside, id); inside = null; }
  }
  assert.equal(lockRef(root, 'pr-7'), '', '全部结束后引用锁已释放');
});

// ---------- 0.10.1：pre-push 登记从被审提交取快照（代码 M1） ----------

const Y_BODY = `${SRC_HEADER}export function dedup(items: string[]) {\n  return [...new Set(items)].sort();\n}\n`;
const X_BODY = `${SRC_HEADER}export function dedup(items: string[]) {\n  return items;\n}\n`;
const TEST_BODY = "import { dedup } from '../src/dedup.ts';\nassert.ok(dedup, 'sorted');\n";
/** pre-push 仓库：提交 Y（改了源码和测试），返回 { root, y, fork }；工作区干净。 */
function snapshotRepo() {
  const root = featureRepo({ reviewMinChars: 0 });
  write(root, 'src/dedup.ts', Y_BODY);
  write(root, 'test/dedup.test.ts', TEST_BODY);
  commitAll(root, 'Y');
  return { root, y: git(root, ['rev-parse', 'HEAD']).trim(), fork: git(root, ['merge-base', 'main', 'HEAD']).trim() };
}

test('S1 pre-push：提交 Y 之后工作区文件改成 X 并用 assume-unchanged 藏起来，对 X 跑闸门得到测试记录；登记被审提交 Y 的 pass 被拒（测试记录与被审提交不一致），不写 review.json（0.10.1 代码 M1）', () => {
  const { root, y, fork } = snapshotRepo();
  write(root, 'src/dedup.ts', X_BODY);
  git(root, ['update-index', '--assume-unchanged', 'src/dedup.ts']);
  assert.equal(git(root, ['status', '--porcelain']).trim(), '', 'git status 看不出工作区被改过');
  const g = runGate({ root });
  assert.equal(g.ok, true, JSON.stringify(g.problems ?? g.messages ?? g));
  const r = prePush(root, reviewData({ reviewedCommit: y, reviewedBase: fork }));
  assert.equal(r.ok, false, '测试记录是对 X 跑的，不是被审的 Y');
  assert.match(r.message, /测试记录/);
  assert.equal(readRecord(root, 'review.json'), null, '拒绝时不写记录');
});

test('S2 恢复文件、去掉 assume-unchanged，对 Y 跑闸门后登记成功；记录的树哈希与文档哈希等于 treeHashAt(root, Y, 范围)（0.10.1 代码 M1）', () => {
  const { root, y, fork } = snapshotRepo();
  write(root, 'src/dedup.ts', X_BODY);
  git(root, ['update-index', '--assume-unchanged', 'src/dedup.ts']);
  write(root, 'src/dedup.ts', Y_BODY);
  git(root, ['update-index', '--no-assume-unchanged', 'src/dedup.ts']);
  assert.equal(git(root, ['status', '--porcelain']).trim(), '');
  assert.equal(runGate({ root }).ok, true);
  const r = prePush(root, reviewData({ reviewedCommit: y, reviewedBase: fork }));
  assert.equal(r.ok, true, r.message);
  assert.equal(typeof LIB.treeHashAt, 'function', 'lib.mjs 应导出 treeHashAt');
  const { scope, docs } = gateScope(root, loadConfig(root));
  const rec = readRecord(root, 'review.json');
  assert.equal(rec.treeHash, LIB.treeHashAt(root, y, scope));
  assert.equal(rec.docHash, LIB.treeHashAt(root, y, docs));
});

test('S3 treeHashAt(root, rev, files) 与干净工作区上的 treeHash 相同；含被删除或 rev 里没有的文件时同样相同（记为 deleted）（0.10.1 代码 M1）', () => {
  assert.equal(typeof LIB.treeHashAt, 'function', 'lib.mjs 应导出 treeHashAt');
  const { root } = snapshotRepo();
  const files = ['src/dedup.ts', 'test/dedup.test.ts'];
  assert.equal(LIB.treeHashAt(root, 'HEAD', files), treeHash(root, files));
  assert.notEqual(LIB.treeHashAt(root, 'main', files), LIB.treeHashAt(root, 'HEAD', files), '不同的提交内容不同');
  git(root, ['rm', '-q', '-f', 'src/dedup.ts']);
  commitAll(root, 'drop');
  assert.equal(LIB.treeHashAt(root, 'HEAD', files), treeHash(root, files), '已删除的文件');
  assert.equal(LIB.treeHashAt(root, 'HEAD', ['no/such.ts']), treeHash(root, ['no/such.ts']), 'rev 里没有的文件');
});

test('S4 不给被审范围的 pre-push 登记行为不变：仍用工作区（未提交的改动也按工作区算）（0.10.1 代码 M1）', () => {
  const root = prePushRepo();
  const r = prePush(root, reviewData());
  assert.equal(r.ok, true, r.message);
  const { scope } = gateScope(root, loadConfig(root));
  assert.equal(readRecord(root, 'review.json').treeHash, treeHash(root, scope));
});

// ---------- PR #46 第 1 轮复审的回归 ----------

const intentDir = (root, name) => path.join(commonDir(root), 'engineering-gate', 'lock-intents', name);
/** 在锁的意向目录里放一条意向（pid 文件），mtime 可指定。 */
function putIntent(root, name, pid, at = new Date()) {
  const dir = intentDir(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${pid}-test`);
  fs.writeFileSync(file, String(pid));
  fs.utimesSync(file, at, at);
  return file;
}

test('H2 引用锁文件在、有活着的本套件进程登记了改这个引用的意向：报 EK_LOCK_CONTENDED 并写明是哪个进程，锁文件原样保留（PR #46 第 1、2 轮代码 H、一致性 M1）', () => {
  const { root } = prRepo();
  const file = touchRefLock(root, 'pr-7');
  fs.utimesSync(file, hoursAgo(1), hoursAgo(1));
  const child = liveChild();
  try {
    putIntent(root, 'pr-7', child.pid, hoursAgo(2));
    assert.throws(() => withPrLock(root, '7', () => 1, { retryMs: 200 }), (e) => e.code === 'EK_LOCK_CONTENDED' && e.message.includes(`本套件进程 ${child.pid}`));
    assert.ok(fs.existsSync(file));
  } finally { child.kill(); }
});

test('H2 意向的进程已退出：诊断写明没有活着的本套件进程，仍不删除锁文件，也不删别人的意向记录（PR #46 第 2 轮决定：撤掉自动删除）', () => {
  const { root } = prRepo();
  const file = touchRefLock(root, 'pr-7');
  fs.utimesSync(file, hoursAgo(1), hoursAgo(1));
  const intent = putIntent(root, 'pr-7', deadPid(), hoursAgo(2));
  assert.throws(() => withPrLock(root, '7', () => 3, { retryMs: 200 }), (e) => e.code === 'EK_LOCK_CONTENDED' && /没有活着的本套件进程/.test(e.message));
  assert.ok(fs.existsSync(file));
  assert.ok(fs.existsSync(intent), '诊断只读');
});

test('M2 不再有自动回收：取锁失败后公共目录里不留回收标记（PR #46 第 2 轮代码 M3，随撤掉自动删除一并消除）', () => {
  const { root } = prRepo();
  const file = touchRefLock(root, 'pr-7');
  fs.utimesSync(file, hoursAgo(1), hoursAgo(1));
  assert.throws(() => withPrLock(root, '7', () => 0, { retryMs: 100 }), (e) => e.code === 'EK_LOCK_CONTENDED');
  assert.equal(fs.existsSync(path.join(commonDir(root), 'engineering-gate', 'lock-recovery')), false);
  fs.rmSync(file);
});

test('M2 旧版目录锁的 reclaim 目录残留（不论多久）：报占用并写明人工确认后删除，不自动删；人工删除后照常（PR #46 第 2 轮代码 H2）', () => {
  const { root } = prRepo();
  const base = path.join(commonDir(root), 'engineering-gate', 'pr', '7');
  const lockDir = path.join(base, 'lock');
  const reclaim = path.join(base, 'reclaim');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: deadPid(), startedAt: '2000-01-01T00:00:00.000Z', token: 'old' }));
  fs.mkdirSync(reclaim);
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(reclaim, old, old);
  assert.throws(() => withPrLock(root, '7', () => 1), (e) => e.code === 'EK_LOCK_BUSY' && /reclaim/.test(e.message) && /手动删除/.test(e.message));
  assert.ok(fs.existsSync(reclaim), '不论多久都不自动删除');
  assert.equal(lockRef(root, 'pr-7'), '', '引用锁已释放');
  fs.rmSync(reclaim, { recursive: true });
  assert.equal(withPrLock(root, '7', () => 2), 2);
  assert.equal(fs.existsSync(lockDir), false);
});

test('M2 释放不了（临界区里出现了新的 git 引用锁文件）：只写“没有释放”的警告，fn 的返回值和异常原样交回（PR #46 第 1 轮一致性 M2）', () => {
  const { root } = prRepo();
  const block = () => touchRefLock(root, 'pr-7');
  const warnings = [];
  const write = process.stderr.write;
  process.stderr.write = (s) => { warnings.push(String(s)); return true; };
  try {
    assert.equal(withPrLock(root, '7', () => { block(); return 7; }, { retryMs: 200 }), 7);
    assert.match(warnings.join(''), /没有释放/);
    fs.rmSync(refLockFile(root, 'pr-7'));
    git(root, ['update-ref', '-d', 'refs/engineering-gate/locks/pr-7']);
    assert.throws(() => withPrLock(root, '7', () => { block(); throw new Error('原始错误'); }, { retryMs: 200 }), /原始错误/);
  } finally {
    process.stderr.write = write;
    fs.rmSync(refLockFile(root, 'pr-7'), { force: true });
  }
});

test('C7 新旧版本互相拒绝：新版持锁时旧版算法取不到，新版释放后旧版取得到（PR #46 第 1 轮一致性 M7）', () => {
  const { root } = prRepo();
  const base = path.join(commonDir(root), 'engineering-gate', 'pr', '7');
  const script = path.join(tmpDir('ekit-old-'), 'old-once.mjs');
  fs.writeFileSync(script, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const lock = path.join(process.argv[2], 'lock');",
    "try { fs.mkdirSync(lock); fs.rmSync(lock, { recursive: true }); process.stdout.write('got'); }",
    "catch (e) { if (e.code !== 'EEXIST') throw e; process.stdout.write('busy'); }",
  ].join('\n'));
  const oldOnce = () => spawnSync(process.execPath, [script, base], { encoding: 'utf8' }).stdout;
  assert.equal(withPrLock(root, '7', () => oldOnce()), 'busy', '新版持锁时旧版看到目录锁被占');
  assert.equal(oldOnce(), 'got', '新版释放后旧版取得到');
});

test('M3 树哈希含文件模式：只改可执行位的两个提交 treeHashAt 不同；干净工作区上 treeHash 与 treeHashAt 相同（PR #46 第 1 轮代码 M3）', () => {
  const { root } = prRepo();
  const files = ['src/dedup.ts'];
  const before = git(root, ['rev-parse', 'HEAD']).trim();
  git(root, ['update-index', '--chmod=+x', 'src/dedup.ts']);
  git(root, ['commit', '-q', '-m', 'chmod']);
  git(root, ['checkout', '-q', '--', 'src/dedup.ts']);
  const after = git(root, ['rev-parse', 'HEAD']).trim();
  assert.notEqual(LIB.treeHashAt(root, before, files), LIB.treeHashAt(root, after, files), '只差可执行位也算不同的代码');
  assert.equal(treeHash(root, files), LIB.treeHashAt(root, after, files), '干净工作区与提交一致');
});

test('M3 符号链接按链接本身计：与内容等于链接文本的普通文件不同；干净工作区上与提交一致（PR #46 第 1 轮代码 M3）', { skip: process.platform === 'win32' && 'Windows 默认不检出真符号链接' }, () => {
  const { root } = prRepo();
  fs.symlinkSync('dedup.ts', path.join(root, 'src/link.ts'));
  commitAll(root, 'link');
  const link = git(root, ['rev-parse', 'HEAD']).trim();
  fs.rmSync(path.join(root, 'src/link.ts'));
  fs.writeFileSync(path.join(root, 'src/link.ts'), 'dedup.ts');
  commitAll(root, 'plain');
  const plain = git(root, ['rev-parse', 'HEAD']).trim();
  assert.notEqual(LIB.treeHashAt(root, link, ['src/link.ts']), LIB.treeHashAt(root, plain, ['src/link.ts']));
  git(root, ['checkout', '-q', link]);
  assert.equal(treeHash(root, ['src/link.ts']), LIB.treeHashAt(root, link, ['src/link.ts']));
});

// ---------- PR #46 第 2 轮复审的回归 ----------

test('M6 旧版目录锁释放时读写出错：只写警告，fn 的返回值和异常原样交回（PR #46 第 2 轮代码 M6、一致性 M2）', () => {
  const { root } = prRepo();
  const ownerFile = path.join(commonDir(root), 'engineering-gate', 'pr', '7', 'lock', 'owner.json');
  const lockDir = path.dirname(ownerFile);
  const breakOwner = () => { fs.rmSync(ownerFile, { force: true }); fs.mkdirSync(ownerFile); };
  const warnings = [];
  const write = process.stderr.write;
  process.stderr.write = (s) => { warnings.push(String(s)); return true; };
  try {
    assert.equal(withPrLock(root, '7', () => { breakOwner(); return 8; }), 8);
    assert.match(warnings.join(''), /旧版目录锁[\s\S]*没有释放/);
    fs.rmSync(lockDir, { recursive: true, force: true });
    assert.throws(() => withPrLock(root, '7', () => { breakOwner(); throw new Error('业务错误'); }), /业务错误/);
  } finally {
    process.stderr.write = write;
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
});

test('C8 旧版实际持锁时新版被拒，旧版释放后新版取得到（反向握手；PR #46 第 2 轮一致性 M6）', async () => {
  const { root } = prRepo();
  const base = path.join(commonDir(root), 'engineering-gate', 'pr', '7');
  fs.mkdirSync(base, { recursive: true });
  const dir = tmpDir('ekit-old-hold-');
  const held = path.join(dir, 'held');
  const release = path.join(dir, 'release');
  const script = path.join(dir, 'old-hold.mjs');
  fs.writeFileSync(script, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    'const [base, held, release] = process.argv.slice(2);',
    "const lock = path.join(base, 'lock');",
    'fs.mkdirSync(lock);',
    "fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token: 'old' }));",
    "fs.writeFileSync(held, 'yes');",
    'while (!fs.existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);',
    'fs.rmSync(lock, { recursive: true, force: true });',
  ].join('\n'));
  const child = spawn(process.execPath, [script, base, held, release], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('close', resolve));
  try {
    const until = Date.now() + 10000;
    while (!fs.existsSync(held) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(held), '旧版进程已持锁');
    assert.throws(() => withPrLock(root, '7', () => 1), (e) => e.code === 'EK_LOCK_BUSY');
    fs.writeFileSync(release, 'go');
    assert.equal(await exited, 0, '旧版子进程正常释放并退出');
    assert.equal(fs.existsSync(path.join(base, 'lock')), false, '旧版自己删掉了目录锁（不是新版回收的）');
    assert.equal(withPrLock(root, '7', () => 2), 2, '旧版释放后新版取得到');
  } finally { child.kill(); }
});

test('M4 core.symlinks 与 core.fileMode 分开判断：symlinks 关、fileMode 开时检出成普通文件的链接与提交一致；symlinks 开时内容等于链接文本的普通文件与链接不同（PR #46 第 2 轮代码 M4、一致性 M7）', () => {
  const { root } = prRepo();
  const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: 'dedup.ts', encoding: 'utf8' }).stdout.trim();
  git(root, ['update-index', '--add', '--cacheinfo', `120000,${blob},src/link.ts`]);
  git(root, ['commit', '-q', '-m', 'link']);
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const files = ['src/link.ts'];
  git(root, ['config', 'core.symlinks', 'false']);
  git(root, ['config', 'core.fileMode', 'true']);
  fs.rmSync(path.join(root, 'src/link.ts'), { force: true });
  git(root, ['checkout', '-q', '--', 'src/link.ts']);
  assert.equal(fs.lstatSync(path.join(root, 'src/link.ts')).isSymbolicLink(), false, '检出成普通文件');
  assert.equal(treeHash(root, files), LIB.treeHashAt(root, head, files), 'symlinks 关时按索引里的链接模式计');
  git(root, ['config', 'core.symlinks', 'true']);
  git(root, ['config', 'core.fileMode', 'false']);
  assert.notEqual(treeHash(root, files), LIB.treeHashAt(root, head, files), 'symlinks 开时工作区里的普通文件不是链接');
});

// ---------- PR #46 第 3 轮复审的回归 ----------

test('M5 意向文件建不出或删不掉时不影响取锁和释放（只用于诊断；PR #46 第 3 轮代码 M5、一致性 M6）', () => {
  const { root } = prRepo();
  const dir = intentDir(root, 'pr-7');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.writeFileSync(dir, 'not a dir');
  try {
    assert.equal(withPrLock(root, '7', () => 9), 9);
    assert.equal(lockRef(root, 'pr-7'), '', '照常释放');
  } finally { fs.rmSync(dir, { force: true }); }
});

test('M7 父路径已变成普通文件时，工作区摘要把原子路径记为 deleted，与提交快照一致（PR #46 第 3 轮一致性 M7）', { skip: process.platform === 'win32' && 'Windows 上这种路径报 ENOENT，不走 ENOTDIR' }, () => {
  const { root } = prRepo();
  fs.rmSync(path.join(root, 'src'), { recursive: true, force: true });
  fs.writeFileSync(path.join(root, 'src'), 'now a file');
  commitAll(root, 'dir to file');
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  assert.equal(treeHash(root, ['src/dedup.ts']), LIB.treeHashAt(root, head, ['src/dedup.ts']));
});

test('M2 链接按原始链接文本计：core.symlinks 关时检出成普通文件的链接即使命中会改写内容的过滤规则也与提交一致（PR #46 第 3 轮代码 M2、一致性 M5）', () => {
  const { root } = prRepo();
  const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: 'dedup.ts', encoding: 'utf8' }).stdout.trim();
  git(root, ['update-index', '--add', '--cacheinfo', `120000,${blob},src/link.ts`]);
  git(root, ['commit', '-q', '-m', 'link']);
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  git(root, ['config', 'core.symlinks', 'false']);
  // 让 git add 的清洗过滤器改写这个路径的内容：按普通文件算摘要就会和提交里的链接对象不同
  fs.writeFileSync(path.join(root, '.git', 'info', 'attributes'), 'src/link.ts filter=upper\n');
  git(root, ['config', 'filter.upper.clean', `"${process.execPath.replace(/\\/g, '/')}" -e "process.stdin.pipe(require('stream').Transform({transform(c,e,cb){cb(null,String(c).toUpperCase())}})).pipe(process.stdout)"`]);
  fs.rmSync(path.join(root, 'src/link.ts'), { force: true });
  git(root, ['checkout', '-q', '--', 'src/link.ts']);
  assert.equal(treeHash(root, ['src/link.ts']), LIB.treeHashAt(root, head, ['src/link.ts']));
});
