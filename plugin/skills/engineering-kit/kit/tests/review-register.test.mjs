// 复审登记集成测试：真实 git 临时仓库加假 gh，覆盖 S1–S10、H3、H7、A15（登记锁）与合并入口对覆盖的要求。
// 复审者交回的是 ek-review/1 JSON；拒绝路径一律断言没有写任何记录（PR 的 log.jsonl 与 <kind>.json）。不访问网络。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runGate } from '../gate/gate.mjs';
import { readRecord, withPrLock } from '../gate/lib.mjs';
import { mergePr } from '../gate/merge.mjs';
import { compactFindings, fingerprint } from '../gate/review-data.mjs';
import { recordReview } from '../gate/review.mjs';
import { commitAll, failingData, featureRepo, finding, git, read, reviewData, reviewDataFile, SRC_HEADER, write } from './helpers.mjs';

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

test('A15 登记锁：持有者进程还活着时，锁目录再旧也不回收；持有者信息没写成且超过十分钟才回收（PR #42 双审 M1/M3）', () => {
  const { root } = prRepo();
  const dir = path.join(prDir(root), 'lock');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: '2000-01-01T00:00:00.000Z' }));
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(dir, old, old);
  assert.throws(() => withPrLock(root, '7', () => 1), /登记锁被占用/);
  fs.rmSync(path.join(dir, 'owner.json'));
  fs.utimesSync(dir, old, old);
  assert.equal(withPrLock(root, '7', () => 42), 42);
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
