// 轮次收口集成测试（含 0.10.1 的修复差异白名单 W1–W5 与风险登记 P1–P6）：真实 git 临时仓库加假 gh，覆盖 A6–A14、A10b 与两个配置字段（roundClosure、riskRegister）。
// 配置写在 featureRepo 的初始提交里（基准提交上），roundClosure 为 fix-and-record、maxReviewRounds 为 2、pr 流程；拒绝路径同时断言没有写任何记录。不访问网络。
// 接口假设（计划里没写函数名）：review.mjs 导出 writeRisks({ root, pr, fixedIn, gh }) 与 closeRound({ root, pr, summary, gh })，返回 { ok, message }（可以是 Promise）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, FLAT_KEYS, normalizeConfig, toProfile } from '../gate/config.mjs';
import { POLICY_KEYS, isIgnoredDoc, withLock } from '../gate/lib.mjs';
import { mergePr } from '../gate/merge.mjs';
import * as REVIEW from '../gate/review.mjs';
import { recordReview } from '../gate/review.mjs';
import { commitAll, featureRepo, finding, git, read, reviewData, reviewDataFile, SRC_HEADER, write } from './helpers.mjs';

const NL = String.fromCharCode(10);
const BACKSLASH = String.fromCharCode(92);
const CLOSURE = 'fix-and-record';
const REG = 'docs/04-开发/review-risks.jsonl';
const GREEN = [
  { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { __typename: 'StatusContext', context: 'lint', state: 'SUCCESS' },
];
const RED = [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }];

/** 假的 gh：pr view 返回给定最终提交的打开状态 PR（检查结果可换），其余命令成功；调用记在 calls 里。 */
function fakeGh(head, rollup = GREEN) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[1] === 'view') return { status: 0, stdout: JSON.stringify({ state: 'OPEN', headRefOid: head, statusCheckRollup: rollup }), stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  gh.calls = calls;
  return gh;
}

/** pr 流程的功能分支仓库（默认开启收口、上限 2 轮），返回 { root, main }。 */
function rcRepo(config = {}) {
  const root = featureRepo({ reviewFlow: 'pr', reviewMinChars: 0, roundClosure: CLOSURE, maxReviewRounds: 2, ...config });
  return { root, main: git(root, ['rev-parse', 'main']).trim() };
}
const headOf = (root) => git(root, ['rev-parse', 'HEAD']).trim();

/** 在功能分支上再提交一个真实提交，返回提交号。 */
function addCommit(root, n) {
  write(root, `src/f${n}.ts`, `${SRC_HEADER}export const v${n} = ${n};${NL}`);
  commitAll(root, `c${n}`);
  return headOf(root);
}
/** 修复提交：改了发现定位的文件 src/dedup.ts。 */
function fixCommit(root, n) {
  write(root, 'src/dedup.ts', [SRC_HEADER.trimEnd(), 'export function dedup(items: string[]) {', `  return items.length ? [...new Set(items)] : []; // fix ${n}`, '}', ''].join(NL));
  commitAll(root, `fix${n}`);
  return headOf(root);
}

/** 发现：定位到 src/dedup.ts（基准里就有），编号决定级别。 */
const M = (id = 'M1', over = {}) => finding({ id, severity: 'medium', files: ['src/dedup.ts'], ...over });
const H = (id = 'H1', over = {}) => finding({ id, severity: 'high', files: ['src/dedup.ts'], ...over });

/** 每个仓库、每种审查最近一次登记的 fail（发现和提交），用来自动给修后复核补“已修”处置。 */
const LAST = new Map();
/** 登记（PR 7）：数据的被审提交是 head、基准是分叉点（完整覆盖）；PR 的最终提交默认也是 head，可用 prHead 改。 */
function reg(root, kind, verdict, head, findings = [], { prHead, userDecision, dispositions } = {}) {
  const main = git(root, ['rev-parse', 'main']).trim();
  const prev = LAST.get(root + kind);
  const owed = prev && prev.head !== head ? prev.findings.filter((x) => x.severity === 'high' || x.severity === 'medium').map((x) => ({ id: x.id, status: 'fixed', evidence: '已按建议修改并补了测试。' })) : [];
  const d = reviewData({ kind, verdict, findings, reviewedCommit: head, reviewedBase: main, dispositions: dispositions ?? owed });
  const r = recordReview({ root, verdict, reviewer: 'feature-dev:code-reviewer', reportPath: reviewDataFile(d), summary: 's', pr: '7', kind, gh: fakeGh(prHead ?? head), userDecision });
  if (r.ok && verdict === 'fail') LAST.set(root + kind, { head, findings });
  return r;
}
const must = (r) => {
  assert.equal(r.ok, true, r.message);
  return r;
};

const prDir = (root) => path.join(root, '.git', 'engineering-gate', 'pr', '7');
const logRows = (root) => {
  const f = path.join(prDir(root), 'log.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split(NL).filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];
};
const closeFile = (root) => path.join(prDir(root), 'close.json');
const latest = (root, kind = 'code') => JSON.parse(read(root, `.git/engineering-gate/pr/7/${kind}.json`));

/** 取 review.mjs 导出的函数；没有时用清楚的断言失败。 */
async function call(name, args) {
  assert.equal(typeof REVIEW[name], 'function', `review.mjs 应导出 ${name}`);
  return await REVIEW[name](args);
}
/** 本轮失败登记里每条中级发现给一条摘要（'种类:编号=摘要'）：0.10.1 起 risks 必须带 --shared-summary。 */
function sharedFor(root) {
  const rows = logRows(root).filter((r) => r.verdict === 'fail' && (r.kind === 'code' || r.kind === 'consistency'));
  const failHead = rows.at(-1)?.headSha;
  const keys = new Set();
  for (const r of rows.filter((x) => x.headSha === failHead)) for (const x of r.findings ?? []) if (x.severity === 'medium') keys.add(`${r.kind}:${x.id}`);
  return [...keys].map((k) => `${k}=已核对的摘要 ${k}`);
}
const writeRisks = (root, head, extra = {}) => call('writeRisks', { root, pr: '7', fixedIn: [], sharedSummary: sharedFor(root), gh: fakeGh(head), ...extra });
const closeRound = (root, head, extra = {}) => call('closeRound', { root, pr: '7', summary: '只剩中级，已修并写入风险登记', gh: fakeGh(head), ...extra });
const msgOf = (r) => r.message ?? (r.problems ?? []).join('|');

/** 断言 close 被拒：没有写 close.json，也没有追加历史。 */
function assertCloseRefused(root, r, before) {
  assert.equal(r.ok, false, msgOf(r));
  assert.equal(fs.existsSync(closeFile(root)), false, '拒绝时不写 close.json');
  assert.equal(logRows(root).length, before, '拒绝时不追加历史');
}

/** 两轮都只有中级（M1）：第 1 轮 c1，第 2 轮 c2，两种审查收齐 → close-only。 */
function midRounds(config = {}, mk = () => M()) {
  const { root, main } = rcRepo(config);
  const c1 = addCommit(root, 1);
  must(reg(root, 'code', 'fail', c1, [mk()]));
  must(reg(root, 'consistency', 'pass', c1));
  const c2 = addCommit(root, 2);
  must(reg(root, 'code', 'fail', c2, [mk()]));
  must(reg(root, 'consistency', 'pass', c2));
  return { root, main, c1, c2 };
}
/** 两轮都有高级且数量不变（H1、M1）：不是系统性问题，第 2 轮收齐后是 final-next；返回收齐那次登记的输出。 */
function highRounds() {
  const { root, main } = rcRepo();
  const c1 = addCommit(root, 1);
  must(reg(root, 'code', 'fail', c1, [H(), M()]));
  must(reg(root, 'consistency', 'pass', c1));
  const c2 = addCommit(root, 2);
  must(reg(root, 'code', 'fail', c2, [H(), M()]));
  const last = must(reg(root, 'consistency', 'pass', c2));
  return { root, main, c1, c2, last };
}
/** 修复、生成风险登记、提交：返回 { fix, head }。 */
async function fixAndRecord(root, n) {
  const fix = fixCommit(root, n);
  must(await writeRisks(root, fix));
  commitAll(root, 'risks');
  return { fix, head: headOf(root) };
}

// ---------- A11 默认关闭 ----------

test('A11 roundClosure 默认 off：满 2 轮后新提交登记要 --user-decision（与旧行为一致），close 不可用', async () => {
  const { root } = rcRepo({ roundClosure: undefined });
  const c1 = addCommit(root, 1);
  must(reg(root, 'code', 'fail', c1, [M()]));
  const c2 = addCommit(root, 2);
  must(reg(root, 'code', 'fail', c2, [M()]));
  const c3 = addCommit(root, 3);
  const before = logRows(root).length;
  const r = reg(root, 'code', 'pass', c3);
  assert.equal(r.ok, false);
  assert.match(r.message, /--user-decision/);
  assert.doesNotMatch(r.message, /close/);
  assert.equal(logRows(root).length, before, '拒绝时不写记录');
  must(reg(root, 'code', 'pass', c3, [], { userDecision: '用户 2026-11-26 同意继续' }));
  const c = await closeRound(root, c3);
  assertCloseRefused(root, c, before + 1);
});

// ---------- A13 收齐前 ----------

test('A13 第 1 轮只登记了代码复审 fail：新提交上的登记被拒；补登一致性审后放行', () => {
  const { root } = rcRepo();
  const c1 = addCommit(root, 1);
  must(reg(root, 'code', 'fail', c1, [M()]));
  const c2 = addCommit(root, 2);
  const before = logRows(root).length;
  const r = reg(root, 'code', 'pass', c2);
  assert.equal(r.ok, false);
  assert.ok(r.message.includes(c1.slice(0, 12)), `写明要先在 ${c1.slice(0, 12)} 上补登：${r.message}`);
  assert.equal(logRows(root).length, before, '拒绝时不写记录');
  // 补登缺的那种审查（PR 的最终提交暂时回到 c1：迟到的那份是针对 c1 的）
  must(reg(root, 'consistency', 'pass', c1));
  // 收齐后第 1 轮是 open：新提交上的登记放行
  must(reg(root, 'code', 'pass', c2));
  assert.equal(latest(root).verdict, 'pass');
});

// ---------- A6 / A12 / A14 收口 ----------

test('A6 两轮收齐都只有中级：新提交上 pass 被拒（指向 close）；修复并写风险登记后 close 成功，合并入口按收口放行', async () => {
  const { root, c2 } = midRounds();
  const rows = logRows(root).length;
  const c3 = addCommit(root, 3);
  const refused = reg(root, 'code', 'pass', c3);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /close/);
  assert.equal(logRows(root).length, rows, '拒绝时不写记录');
  // 被拒的提交不留在分支上（0.10.1：留着的未复审改动不在收口白名单里，见 W4）
  git(root, ['reset', '-q', '--hard', c2]);

  const fix = fixCommit(root, 4);
  const w = must(await writeRisks(root, fix));
  assert.match(msgOf(w), /review-risks/, '输出写明风险登记文件');
  const lines = read(root, REG).split(NL).filter((l) => l.trim());
  assert.equal(lines.length, 1, '本轮一条中级一条记录');
  const entry = JSON.parse(lines[0]);
  assert.deepEqual([entry.pr, entry.commit, entry.round, entry.kind, entry.id, entry.severity, entry.status], ['7', c2, 2, 'code', 'M1', 'medium', '已修、未再复审']);
  assert.deepEqual(entry.fixedIn, []);
  commitAll(root, 'risks');
  const head = headOf(root);

  const c = must(await closeRound(root, head));
  assert.ok(fs.existsSync(closeFile(root)), '写 close.json');
  const closed = JSON.parse(fs.readFileSync(closeFile(root), 'utf8'));
  assert.equal(closed.headSha, head);
  assert.equal(closed.failHead, c2);
  const last = logRows(root).at(-1);
  assert.equal(last.kind, 'close');
  assert.equal(last.verdict, 'close');
  assert.equal(last.headSha, head);
  assert.equal(last.entries, 1);
  assert.equal(logRows(root).length, rows + 1, 'log 追加一行');
  assert.ok(msgOf(c).length > 0);

  const gh = fakeGh(head);
  const m = mergePr({ root, pr: '7', gh });
  assert.equal(m.ok, true, m.problems.join(' / '));
  assert.match(m.notes.join('|'), /收口/);
  assert.deepEqual(gh.calls.at(-1), ['pr', 'merge', '7', '--squash', '--match-head-commit', head, '--delete-branch']);
});

test('W4 close-only 阶段在 c3 上的登记被拒，但 c3（新增 src/f3.ts）留在分支上，之后再修定位文件：close 拒绝并点名 src/f3.ts（0.10.1 代码 H1；原 A6 放行）', async () => {
  const { root, c2 } = midRounds();
  const rows = logRows(root).length;
  const c3 = addCommit(root, 3);
  const refused = reg(root, 'code', 'pass', c3);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /close/);
  assert.equal(logRows(root).length, rows, '拒绝时不写记录');
  const fix = fixCommit(root, 4);
  must(await writeRisks(root, fix));
  commitAll(root, 'risks');
  const head = headOf(root);
  assert.ok(c2 !== head);
  const c = await closeRound(root, head);
  assertCloseRefused(root, c, rows);
  assert.ok(msgOf(c).includes('src/f3.ts'), msgOf(c));
  assert.match(msgOf(c), /白名单/);
});

test('A12 close 的拒绝：风险登记文件不存在、文件里缺这一条，逐条说明原因，不写 close.json', async () => {
  const { root } = midRounds();
  const fix = fixCommit(root, 3);
  const rows = logRows(root).length;
  const noFile = await closeRound(root, fix);
  assertCloseRefused(root, noFile, rows);
  assert.match(msgOf(noFile), /review-risks/);

  write(root, REG, '');
  commitAll(root, 'empty register');
  const empty = await closeRound(root, headOf(root));
  assertCloseRefused(root, empty, rows);
  assert.match(msgOf(empty), /M1/, '点名缺的条目');
});

test('P4 close 的拒绝：风险登记里的 findingSha 被改了一位，点名这一条（0.10.1 代码 H2；原 A12“文字被改了一个字”）', async () => {
  const { root } = midRounds();
  const fix = fixCommit(root, 3);
  must(await writeRisks(root, fix));
  const entry = JSON.parse(read(root, REG).split(NL)[0]);
  entry.findingSha = `${entry.findingSha.slice(0, -1)}${entry.findingSha.endsWith('0') ? '1' : '0'}`;
  write(root, REG, `${JSON.stringify(entry)}${NL}`);
  commitAll(root, 'risks');
  const rows = logRows(root).length;
  const r = await closeRound(root, headOf(root));
  assertCloseRefused(root, r, rows);
  assert.match(msgOf(r), /M1/);
});

test('A12 close 的拒绝：修复差异只改了风险登记本身（定位文件没改、fixedIn 为空），点名这一条', async () => {
  const { root, c2 } = midRounds();
  const w = await writeRisks(root, c2);
  must(w);
  commitAll(root, 'risks only');
  const rows = logRows(root).length;
  const r = await closeRound(root, headOf(root));
  assertCloseRefused(root, r, rows);
  assert.match(msgOf(r), /M1/);
  assert.match(msgOf(r), /修复差异/);
});

test('A12 close 的拒绝：CI 没有全过时不能 close', async () => {
  const { root } = midRounds();
  const { head } = await fixAndRecord(root, 3);
  const rows = logRows(root).length;
  const r = await closeRound(root, head, { gh: fakeGh(head, RED) });
  assertCloseRefused(root, r, rows);
  assert.match(msgOf(r), /CI|test/);
});

test('A12 close 的拒绝：阶段不是 close-only（第 1 轮后还是 open）时不能 close', async () => {
  const { root } = rcRepo();
  const c1 = addCommit(root, 1);
  must(reg(root, 'code', 'fail', c1, [M()]));
  must(reg(root, 'consistency', 'pass', c1));
  const fix = fixCommit(root, 2);
  const rows = logRows(root).length;
  const r = await closeRound(root, fix);
  assertCloseRefused(root, r, rows);
  assert.match(msgOf(r), /open/);
});

// ---------- A7 / A8 / A9 最后一轮 ----------

test('A7 第 2 轮有高级：收齐时提示最后一轮；下一个新提交的登记不要 --user-decision 即放行；再换一个提交被拒', () => {
  const { root, c2, last } = highRounds();
  assert.match(last.message, /最后一轮/);
  const c3 = addCommit(root, 3);
  const r = reg(root, 'code', 'pass', c3);
  assert.equal(r.ok, true, r.message);
  assert.equal(latest(root).userDecision, null, '没有带用户决定');
  const rows = logRows(root).length;
  const c4 = addCommit(root, 4);
  const other = reg(root, 'code', 'pass', c4);
  assert.equal(other.ok, false);
  assert.match(other.message, /--user-decision/);
  assert.ok(other.message.includes(c3.slice(0, 12)), '写明只认哪个提交');
  assert.equal(logRows(root).length, rows, '拒绝时不写记录');
  // 最后一轮的提交上另一种审查照常放行；同种审查不能登两次
  must(reg(root, 'consistency', 'pass', c3));
  assert.equal(reg(root, 'code', 'pass', c3).ok, false);
  assert.ok(c2 !== c3);
});

test('A9 最后一轮只剩中级：新提交上登记不再放行、close 可用', async () => {
  const { root } = highRounds();
  const c3 = addCommit(root, 3);
  must(reg(root, 'code', 'fail', c3, [M()]));
  must(reg(root, 'consistency', 'pass', c3));
  const c4 = addCommit(root, 4);
  const refused = reg(root, 'code', 'pass', c4);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /close/);
  git(root, ['reset', '-q', '--hard', c3]); // 被拒的 c4 不留在分支上（0.10.1：留着的未复审改动不在收口白名单里）
  const { head } = await fixAndRecord(root, 5);
  must(await closeRound(root, head));
  assert.ok(fs.existsSync(closeFile(root)));
  assert.equal(JSON.parse(fs.readFileSync(closeFile(root), 'utf8')).failHead, c3);
  const m = mergePr({ root, pr: '7', gh: fakeGh(head) });
  assert.equal(m.ok, true, m.problems.join(' / '));
});

test('A8 / A10b 最后一轮仍有高级：stop，登记要 --user-decision，带了放行并记下用户决定', () => {
  const { root } = highRounds();
  const c3 = addCommit(root, 3);
  must(reg(root, 'code', 'fail', c3, [H(), M()]));
  const done = must(reg(root, 'consistency', 'pass', c3));
  assert.match(done.message, /停下/);
  const c4 = addCommit(root, 4);
  const rows = logRows(root).length;
  for (const verdict of ['pass', 'fail']) {
    const r = reg(root, 'code', verdict, c4, verdict === 'fail' ? [M()] : []);
    assert.equal(r.ok, false, verdict);
    assert.match(r.message, /停下/);
    assert.match(r.message, /--user-decision/);
  }
  assert.equal(logRows(root).length, rows, '拒绝时不写记录');
  const decision = '用户 2026-11-26 在对话中同意继续，单开专项处理';
  must(reg(root, 'code', 'pass', c4, [], { userDecision: decision }));
  assert.equal(latest(root).userDecision, decision);
});

// ---------- A10 系统性问题 ----------

test('A10 第 2 轮的发现带 prior（同一问题再现）：即使上限是 3 也 stop；带 --user-decision 才能继续', () => {
  const { root } = rcRepo({ maxReviewRounds: 3 });
  const c1 = addCommit(root, 1);
  must(reg(root, 'code', 'fail', c1, [M()]));
  must(reg(root, 'consistency', 'pass', c1));
  const c2 = addCommit(root, 2);
  const notFixed = [{ id: 'M1', status: 'not-fixed', evidence: '同样的输入仍然返回 undefined。' }];
  must(reg(root, 'code', 'fail', c2, [M('M2', { prior: 'M1' })], { dispositions: notFixed }));
  const done = must(reg(root, 'consistency', 'pass', c2));
  assert.match(done.message, /停下/);
  const c3 = addCommit(root, 3);
  const rows = logRows(root).length;
  const r = reg(root, 'code', 'pass', c3);
  assert.equal(r.ok, false);
  assert.match(r.message, /停下/);
  assert.match(r.message, /--user-decision/);
  assert.equal(logRows(root).length, rows);
  must(reg(root, 'code', 'pass', c3, [], { userDecision: '用户同意继续' }));
});

// ---------- A14 收口失效 ----------

/** 已经 close 成功的仓库：返回 { root, head, c2 }。 */
async function closedRepo() {
  const { root, c2 } = midRounds();
  const { head } = await fixAndRecord(root, 3);
  must(await closeRound(root, head));
  return { root, head, c2 };
}

test('A14 close 之后又改了非文档文件：合并入口不认收口，退回普通双审并列出两边原因；对新提交登记两份 pass 后可合并', async () => {
  const { root } = await closedRepo();
  const next = addCommit(root, 9);
  const gh = fakeGh(next);
  const m = mergePr({ root, pr: '7', gh });
  assert.equal(m.ok, false);
  const all = m.problems.join(' / ');
  assert.match(all, /代码复审/, `普通双审的原因：${all}`);
  assert.match(all, /收口|close/i, `收口的原因：${all}`);
  assert.equal(gh.calls.some((a) => a[1] === 'merge'), false, '拒绝时不调用 gh pr merge');
  // 阶段仍是 close-only：对新提交登记两份 pass 要带用户决定
  must(reg(root, 'code', 'pass', next, [], { userDecision: '用户同意改动后重新走普通双审' }));
  must(reg(root, 'consistency', 'pass', next, [], { userDecision: '用户同意改动后重新走普通双审' }));
  const ok = mergePr({ root, pr: '7', gh: fakeGh(next) });
  assert.equal(ok.ok, true, ok.problems.join(' / '));
});

test('A14 close 之后风险登记被改（findingSha 篡改，在最终提交上不成立）：合并入口不认收口（0.10.1 代码 H2；原 A14 改 fix 文字）', async () => {
  const { root } = await closedRepo();
  const entry = JSON.parse(read(root, REG).split(NL)[0]);
  entry.findingSha = `${entry.findingSha.slice(0, -1)}${entry.findingSha.endsWith('0') ? '1' : '0'}`;
  write(root, REG, `${JSON.stringify(entry)}${NL}`);
  commitAll(root, 'tamper register');
  const head = headOf(root);
  const gh = fakeGh(head);
  const m = mergePr({ root, pr: '7', gh });
  assert.equal(m.ok, false);
  assert.match(m.problems.join(' / '), /收口|close/i);
  assert.equal(gh.calls.some((a) => a[1] === 'merge'), false);
});

test('A14 close 之后只改了文档（风险登记不算文档）：仍按收口放行', async () => {
  const { root } = await closedRepo();
  write(root, 'docs/note.md', `# 说明${NL}只是文档。${NL}`);
  commitAll(root, 'docs only');
  const head = headOf(root);
  const m = mergePr({ root, pr: '7', gh: fakeGh(head) });
  assert.equal(m.ok, true, m.problems.join(' / '));
  assert.match(m.notes.join('|'), /收口/);
});

// ---------- 配置 ----------

test('A11 配置：roundClosure 默认 off、riskRegister 默认路径，两者是判定策略字段', () => {
  assert.equal(DEFAULTS.roundClosure, 'off');
  assert.equal(DEFAULTS.riskRegister, REG);
  const eff = normalizeConfig({});
  assert.equal(eff.roundClosure, 'off');
  assert.equal(eff.riskRegister, REG);
  assert.ok(FLAT_KEYS.includes('roundClosure') && FLAT_KEYS.includes('riskRegister'));
  assert.ok(POLICY_KEYS.includes('roundClosure') && POLICY_KEYS.includes('riskRegister'));
});

test('A11 配置：roundClosure 只能是 off 或 fix-and-record，非 off 要求 pr 流程', () => {
  assert.throws(() => normalizeConfig({ reviewFlow: 'pr', roundClosure: 'bogus' }), /roundClosure/);
  assert.throws(() => normalizeConfig({ reviewFlow: 'pr', roundClosure: true }), /roundClosure/);
  assert.throws(() => normalizeConfig({ roundClosure: CLOSURE }), /roundClosure|pr/);
  assert.throws(() => normalizeConfig({ reviewFlow: 'pre-push', roundClosure: CLOSURE }), /pr/);
  assert.equal(normalizeConfig({ reviewFlow: 'pr', roundClosure: CLOSURE }).roundClosure, CLOSURE);
  assert.equal(normalizeConfig({ reviewFlow: 'pre-push', roundClosure: 'off' }).roundClosure, 'off');
  // profile 结构里同样校验
  assert.throws(() => normalizeConfig({ profile: 2, modules: { review: { roundClosure: CLOSURE } } }), /pr/);
  assert.equal(normalizeConfig({ profile: 2, modules: { gate: { reviewFlow: 'pr' }, review: { roundClosure: CLOSURE } } }).roundClosure, CLOSURE);
});

test('A12 配置：riskRegister 须是相对路径、正斜杠、不含 .. 与空段、以 .jsonl 结尾', () => {
  const bad = [
    '', '  ', 5, null,
    'docs/risks.txt', 'docs/risks.json', 'docs/risks.jsonl/', 'docs/risks',
    '../risks.jsonl', 'docs/../risks.jsonl', 'docs//risks.jsonl', '/docs/risks.jsonl', 'C:/docs/risks.jsonl',
    `docs${BACKSLASH}risks.jsonl`,
  ];
  for (const value of bad) assert.throws(() => normalizeConfig({ reviewFlow: 'pr', riskRegister: value }), /riskRegister/, JSON.stringify(value));
  for (const value of ['risks.jsonl', 'docs/risks.jsonl', 'docs/04-开发/review-risks.jsonl', 'a/b/c.jsonl']) {
    assert.equal(normalizeConfig({ reviewFlow: 'pr', riskRegister: value }).riskRegister, value);
  }
  assert.throws(() => normalizeConfig({ profile: 2, modules: { review: { riskRegister: 'docs/x.txt' } } }), /riskRegister/);
});

test('A11 配置：toProfile 只在非默认时写出 roundClosure 与 riskRegister', () => {
  const plain = toProfile({ reviewFlow: 'pr' });
  assert.equal(Object.hasOwn(plain.modules.review, 'roundClosure'), false);
  assert.equal(Object.hasOwn(plain.modules.review, 'riskRegister'), false);
  const custom = toProfile({ reviewFlow: 'pr', roundClosure: CLOSURE, riskRegister: 'docs/risks.jsonl' });
  assert.equal(custom.modules.review.roundClosure, CLOSURE);
  assert.equal(custom.modules.review.riskRegister, 'docs/risks.jsonl');
  const again = normalizeConfig(custom);
  assert.equal(again.roundClosure, CLOSURE);
  assert.equal(again.riskRegister, 'docs/risks.jsonl');
  const onlyPath = toProfile({ riskRegister: 'docs/risks.jsonl' });
  assert.equal(Object.hasOwn(onlyPath.modules.review, 'roundClosure'), false);
  assert.equal(onlyPath.modules.review.riskRegister, 'docs/risks.jsonl');
});

test('A14 配置：风险登记文件永远不算“只改文档”', () => {
  const ignore = ['docs/**', '**/*.md', 'README.md'];
  assert.equal(isIgnoredDoc('docs/note.md', ignore), true, '对照：普通文档算');
  assert.equal(isIgnoredDoc(REG, ignore), false);
});

// ---------- PR #43 第 1 轮复审的回归 ----------

test('H7 收口要求失败那一轮的每种审查都是完整覆盖：代码复审只审了部分差异时 close 被拒、合并入口不放行（PR #43 代码 H1、一致性 M1）', async () => {
  const { root, main } = rcRepo();
  const c1 = addCommit(root, 1);
  must(reg(root, 'code', 'fail', c1, [M()]));
  must(reg(root, 'consistency', 'pass', c1));
  const mid = addCommit(root, 2);
  const c2 = addCommit(root, 3);
  // 第 2 轮的代码复审只审了 mid..c2（部分覆盖，只能登记 fail）
  const partial = reviewData({ kind: 'code', verdict: 'fail', findings: [M('M2')], reviewedCommit: c2, reviewedBase: mid, dispositions: [{ id: 'M1', status: 'fixed', evidence: '已按建议修改并补了测试。' }] });
  const r = must(recordReview({ root, verdict: 'fail', reviewer: 'feature-dev:code-reviewer', reportPath: reviewDataFile(partial), summary: 's', pr: '7', kind: 'code', gh: fakeGh(c2) }));
  assert.equal(r.record.coverage, 'partial');
  must(reg(root, 'consistency', 'pass', c2));
  const fix = fixCommit(root, 4);
  must(await writeRisks(root, fix));
  commitAll(root, 'risks');
  const head = headOf(root);
  const before = logRows(root).length;
  const c = await closeRound(root, head);
  assertCloseRefused(root, c, before);
  assert.match(msgOf(c), /覆盖/);
  // close 被拒就没有收口记录，合并入口走普通双审核对（代码复审是 fail），同样不放行
  const gh = fakeGh(head);
  const m = mergePr({ root, pr: '7', gh });
  assert.equal(m.ok, false, '部分覆盖不能借收口合并');
  assert.ok(!gh.calls.some((x) => x[1] === 'merge'), '没有执行合并');
});

test('A12 风险登记的读改写按文件串行：别的 PR 正在写同一份风险登记时，risks 报占用、不写文件（PR #43 代码 H3、一致性 M8）', async () => {
  const { root } = midRounds();
  const fix = fixCommit(root, 4);
  // writeRisks 在调用时同步执行（call 包装成 Promise），所以它是在锁被别人持有期间运行的
  let pending;
  withLock(root, 'risk-register', () => { pending = writeRisks(root, fix); });
  const inner = await pending.catch((e) => ({ ok: false, message: e.message }));
  assert.equal(inner.ok, false);
  assert.match(msgOf(inner), /占用/);
  assert.equal(fs.existsSync(path.join(root, REG)), false, '没有写风险登记');
  must(await writeRisks(root, fix));
});

test('H7 收口被部分覆盖拦下后，在失败提交上补一份完整覆盖的同种复审（不要用户决定）即可收口（PR #43 第 2 轮代码 M2、一致性 M2）', async () => {
  const { root } = rcRepo();
  const c1 = addCommit(root, 1);
  must(reg(root, 'code', 'fail', c1, [M()]));
  must(reg(root, 'consistency', 'pass', c1));
  const mid = addCommit(root, 2);
  const c2 = addCommit(root, 3);
  const partial = reviewData({ kind: 'code', verdict: 'fail', findings: [M('M2')], reviewedCommit: c2, reviewedBase: mid, dispositions: [{ id: 'M1', status: 'fixed', evidence: '已按建议修改并补了测试。' }] });
  must(recordReview({ root, verdict: 'fail', reviewer: 'feature-dev:code-reviewer', reportPath: reviewDataFile(partial), summary: 's', pr: '7', kind: 'code', gh: fakeGh(c2) }));
  must(reg(root, 'consistency', 'pass', c2));
  const refused = await closeRound(root, c2);
  assert.equal(refused.ok, false);
  assert.match(msgOf(refused), /补/);
  // 照提示在失败提交 c2 上补一份完整覆盖的代码复审：收口阶段放行
  const full = must(reg(root, 'code', 'fail', c2, [M('M2')], { prHead: c2 }));
  assert.equal(full.record.coverage, 'full');
  const fix = fixCommit(root, 4);
  must(await writeRisks(root, fix));
  commitAll(root, 'risks');
  must(await closeRound(root, headOf(root)));
});

// ---------- 0.10.1：收口的修复差异白名单（代码 H1） ----------

/** midRounds 之后：修定位文件、另新增 src/f9.ts（白名单外）、写风险登记并提交。返回 { root, head, rows }。 */
async function strayRepo() {
  const { root, c2 } = midRounds();
  fixCommit(root, 3);
  addCommit(root, 9);
  const fix = headOf(root);
  must(await writeRisks(root, fix));
  commitAll(root, 'risks');
  return { root, c2, head: headOf(root), rows: logRows(root).length };
}

test('W1 修复差异里有白名单外的新增文件 src/f9.ts：close 拒绝，点名文件、写明白名单与 --user-decision；不写 close.json；合并入口不放行（0.10.1 代码 H1）', async () => {
  const { root, head, rows } = await strayRepo();
  const r = await closeRound(root, head);
  assertCloseRefused(root, r, rows);
  assert.ok(msgOf(r).includes('src/f9.ts'), msgOf(r));
  assert.match(msgOf(r), /白名单/);
  assert.match(msgOf(r), /--user-decision/);
  const gh = fakeGh(head);
  const m = mergePr({ root, pr: '7', gh });
  assert.equal(m.ok, false, '没有收口记录，合并入口退回普通双审');
  assert.equal(gh.calls.some((a) => a[1] === 'merge'), false, '没有执行合并');
});

test('W2 修复差异含定位文件 src/dedup.ts、测试文件、文档与风险登记：close 成功，输出按文件列出增删行数（每个路径都出现）（0.10.1 代码 H1）', async () => {
  const { root } = midRounds();
  fixCommit(root, 3);
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nassert.ok(dedup, 'fixed');\n");
  write(root, 'docs/note.md', `# 说明${NL}修复说明。${NL}`);
  commitAll(root, 'tests and docs');
  must(await writeRisks(root, headOf(root)));
  commitAll(root, 'risks');
  const c = must(await closeRound(root, headOf(root)));
  assert.ok(fs.existsSync(closeFile(root)));
  for (const file of ['src/dedup.ts', 'test/dedup.test.ts', 'docs/note.md']) assert.ok(msgOf(c).includes(file), `${file} 出现在输出里：${msgOf(c)}`);
});

test('W3 定位文件之外的修复文件经 --fixed-in 申报才放行：申报的 src/other.ts 通过；再多一个未申报的 src/f9.ts 时拒绝并点名（0.10.1 代码 H1）', async () => {
  const ok = midRounds();
  write(ok.root, 'src/other.ts', `${SRC_HEADER}export const other = 1;${NL}`);
  commitAll(ok.root, 'fix elsewhere');
  must(await writeRisks(ok.root, headOf(ok.root), { fixedIn: ['code:M1=src/other.ts'] }));
  commitAll(ok.root, 'risks');
  must(await closeRound(ok.root, headOf(ok.root)));
  assert.ok(fs.existsSync(closeFile(ok.root)));

  const bad = midRounds();
  write(bad.root, 'src/other.ts', `${SRC_HEADER}export const other = 1;${NL}`);
  commitAll(bad.root, 'fix elsewhere');
  addCommit(bad.root, 9);
  must(await writeRisks(bad.root, headOf(bad.root), { fixedIn: ['code:M1=src/other.ts'] }));
  commitAll(bad.root, 'risks');
  const rows = logRows(bad.root).length;
  const r = await closeRound(bad.root, headOf(bad.root));
  assertCloseRefused(bad.root, r, rows);
  assert.ok(msgOf(r).includes('src/f9.ts'), msgOf(r));
});

test('W5 W1 被拒后由用户决定对最终提交登记两份 pass（带 userDecision）：合并入口按普通双审合并（0.10.1 代码 H1）', async () => {
  const { root, head, rows } = await strayRepo();
  assertCloseRefused(root, await closeRound(root, head), rows);
  const decision = '用户 2026-11-27 同意含 src/f9.ts 的最终提交走普通双审';
  must(reg(root, 'code', 'pass', head, [], { userDecision: decision }));
  must(reg(root, 'consistency', 'pass', head, [], { userDecision: decision }));
  const gh = fakeGh(head);
  const m = mergePr({ root, pr: '7', gh });
  assert.equal(m.ok, true, m.problems.join(' / '));
  assert.deepEqual(gh.calls.at(-1), ['pr', 'merge', '7', '--squash', '--match-head-commit', head, '--delete-branch']);
});

// ---------- 0.10.1：风险登记只存编号、指纹和摘要（代码 H2） ----------

const MARK = 'SECRET-MARKER-7f3a';
const secretFinding = () => M('M1', { location: `src/dedup.ts:${MARK}`, problem: `问题 ${MARK}`, reason: `理由 ${MARK}`, fix: `改法 ${MARK}` });

test('P1 发现的位置、问题、理由、建议改法的原文不进风险登记、close.json、close 与 merge 的输出；close、merge 成功；条目键恰好是约定的 11 个（0.10.1 代码 H2）', async () => {
  const { root, c2 } = midRounds({}, secretFinding);
  const fix = fixCommit(root, 3);
  const w = must(await writeRisks(root, fix, { sharedSummary: ['code:M1=只记可共享的摘要'] }));
  const registerText = read(root, REG);
  assert.ok(!registerText.includes(MARK), '风险登记文件里没有原文');
  assert.ok(!msgOf(w).includes(MARK), 'risks 的输出里没有原文');
  const entry = JSON.parse(registerText.split(NL)[0]);
  assert.deepEqual(Object.keys(entry).sort(), ['commit', 'dataSha', 'findingSha', 'fixedIn', 'id', 'kind', 'pr', 'round', 'severity', 'status', 'summary']);
  assert.equal(entry.commit, c2);
  assert.equal(entry.summary, '只记可共享的摘要');
  assert.match(entry.findingSha, /^[0-9a-f]{64}$/);
  assert.match(entry.dataSha, /^[0-9a-f]{64}$/);
  commitAll(root, 'risks');
  const head = headOf(root);
  const c = must(await closeRound(root, head));
  assert.ok(!msgOf(c).includes(MARK), 'close 的输出里没有原文');
  assert.ok(!fs.readFileSync(closeFile(root), 'utf8').includes(MARK), 'close.json 里没有原文');
  const m = mergePr({ root, pr: '7', gh: fakeGh(head) });
  assert.equal(m.ok, true, m.problems.join(' / '));
  assert.ok(!JSON.stringify(m).includes(MARK), 'merge 的输出里没有原文');
});

test('P2 risks 不带 --shared-summary：拒绝，点名 M1 与 --shared-summary，不写风险登记文件（0.10.1 代码 H2）', async () => {
  const { root } = midRounds();
  const fix = fixCommit(root, 3);
  for (const sharedSummary of [undefined, []]) {
    const r = await writeRisks(root, fix, { sharedSummary });
    assert.equal(r.ok, false, msgOf(r));
    assert.match(msgOf(r), /M1/);
    assert.match(msgOf(r), /--shared-summary/);
    assert.equal(fs.existsSync(path.join(root, REG)), false, '不写文件');
  }
});

test('P3 摘要含换行、超过 300 字符、只有空白：拒绝并不写文件；恰好 300 字符与前后有空白的合格摘要通过（0.10.1 代码 H2）', async () => {
  const { root } = midRounds();
  const fix = fixCommit(root, 3);
  const bad = { 换行: `第一行${NL}第二行`, 回车: '第一行\r第二行', 制表符: '有\t制表符', 过长: 'x'.repeat(301), 只有空白: '    ' };
  for (const [name, text] of Object.entries(bad)) {
    const r = await writeRisks(root, fix, { sharedSummary: [`code:M1=${text}`] });
    assert.equal(r.ok, false, `${name}：${msgOf(r)}`);
    assert.equal(fs.existsSync(path.join(root, REG)), false, `${name}：不写文件`);
  }
  must(await writeRisks(root, fix, { sharedSummary: [`code:M1=${'x'.repeat(300)}`] }));
  assert.equal(JSON.parse(read(root, REG).split(NL)[0]).summary.length, 300);
  must(await writeRisks(root, fix, { sharedSummary: ['code:M1=  前后有空白  '] }));
  assert.equal(JSON.parse(read(root, REG).split(NL)[0]).summary, '前后有空白', '去掉首尾空白后记录');
});

test('P4 close 的拒绝：已提交条目的 findingSha 或 dataSha 被篡改，点名 M1，不写 close.json；摘要被改成不合格（空白）同样拒绝（0.10.1 代码 H2）', async () => {
  for (const field of ['findingSha', 'dataSha', 'summary']) {
    const { root } = midRounds();
    must(await writeRisks(root, fixCommit(root, 3)));
    const entry = JSON.parse(read(root, REG).split(NL)[0]);
    entry[field] = field === 'summary' ? '   ' : 'e'.repeat(64);
    write(root, REG, `${JSON.stringify(entry)}${NL}`);
    commitAll(root, 'tamper');
    const rows = logRows(root).length;
    const r = await closeRound(root, headOf(root));
    assertCloseRefused(root, r, rows);
    assert.match(msgOf(r), /M1/, field);
  }
});

test('P5 第二次 risks 只带 --fixed-in、不带摘要：沿用原摘要，成功（0.10.1 代码 H2）', async () => {
  const { root } = midRounds();
  const fix = fixCommit(root, 3);
  must(await writeRisks(root, fix, { sharedSummary: ['code:M1=原来的摘要'] }));
  must(await writeRisks(root, fix, { sharedSummary: undefined, fixedIn: ['code:M1=src/dedup.ts'] }));
  const entry = JSON.parse(read(root, REG).split(NL)[0]);
  assert.equal(entry.summary, '原来的摘要');
  assert.deepEqual(entry.fixedIn, ['src/dedup.ts']);
});

test('P6 风险登记里有同身份的旧格式行：close 拒绝并写“旧格式”；重跑 risks 后该行变新格式、文件里不再有旧原文，无关的旧格式行原样保留（0.10.1 代码 H2）', async () => {
  const { root, c2 } = midRounds();
  const fix = fixCommit(root, 3);
  const OLD = '旧原文-仅在旧格式里';
  const identity = { pr: '7', commit: c2, round: 2, kind: 'code', id: 'M1', severity: 'medium', location: `src/dedup.ts:${OLD}`, problem: OLD, reason: OLD, fix: OLD, status: '已修、未再复审', fixedIn: [] };
  const unrelated = { pr: '3', commit: 'a'.repeat(40), round: 1, kind: 'code', id: 'M5', severity: 'medium', location: 'src/x.ts:1', problem: '无关旧行', reason: '理由', fix: '改法', status: '已修、未再复审', fixedIn: [] };
  const unrelatedLine = JSON.stringify(unrelated);
  write(root, REG, `${unrelatedLine}${NL}${JSON.stringify(identity)}${NL}`);
  commitAll(root, 'legacy register');
  const rows = logRows(root).length;
  const refused = await closeRound(root, headOf(root));
  assertCloseRefused(root, refused, rows);
  assert.match(msgOf(refused), /旧格式/);

  must(await writeRisks(root, fix));
  const text = read(root, REG);
  assert.ok(!text.includes(OLD), '同身份的旧原文不再留在文件里');
  assert.ok(text.split(NL).includes(unrelatedLine), '无关的旧格式行原样保留');
  const mine = text.split(NL).filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((e) => e.pr === '7' && e.id === 'M1');
  assert.equal(mine.length, 1);
  assert.deepEqual(Object.keys(mine[0]).sort(), ['commit', 'dataSha', 'findingSha', 'fixedIn', 'id', 'kind', 'pr', 'round', 'severity', 'status', 'summary']);
  commitAll(root, 'risks');
  must(await closeRound(root, headOf(root)));
});

// ---------- PR #46 第 1 轮复审的回归 ----------

test('H1 risks 之后改写已提交登记里的 fixedIn、借它带进无关文件：close 与合并入口都拒绝；本机没有 risks 的申报记录时同样拒绝（PR #46 第 1 轮代码 H1、一致性 M4）', async () => {
  const { root } = midRounds();
  const fix = fixCommit(root, 3);
  must(await writeRisks(root, fix));
  const entry = JSON.parse(read(root, REG).split(NL)[0]);
  entry.fixedIn = ['src/f9.ts'];
  write(root, REG, `${JSON.stringify(entry)}${NL}`);
  write(root, 'src/f9.ts', `${SRC_HEADER}export const v9 = 9;${NL}`);
  commitAll(root, 'tampered fixedIn');
  const head = headOf(root);
  const rows = logRows(root).length;
  const r = await closeRound(root, head);
  assertCloseRefused(root, r, rows);
  assert.match(msgOf(r), /申报/);
  const gh = fakeGh(head);
  const m = mergePr({ root, pr: '7', gh });
  assert.equal(m.ok, false);
  assert.equal(gh.calls.some((a) => a[1] === 'merge'), false, '没有执行合并');

  // 本机的申报记录不在（例如登记是手写或在别处生成的）：拒绝并指向在本机运行 risks
  const other = midRounds();
  const fix2 = fixCommit(other.root, 3);
  must(await writeRisks(other.root, fix2));
  fs.rmSync(path.join(prDir(other.root), 'risks.json'));
  commitAll(other.root, 'risks');
  const missing = await closeRound(other.root, headOf(other.root));
  assert.equal(missing.ok, false);
  assert.match(msgOf(missing), /本机没有 risks/);
});

test('M5 risks 的输出点出仍是旧格式的无关行行号，不回显原文（PR #46 第 1 轮一致性 M5）', async () => {
  const { root } = midRounds();
  const fix = fixCommit(root, 3);
  const OLD = '无关旧行里的原文';
  const unrelated = { pr: '3', commit: 'a'.repeat(40), round: 1, kind: 'code', id: 'M5', severity: 'medium', location: 'src/x.ts:1', problem: OLD, reason: '理由', fix: '改法', status: '已修、未再复审', fixedIn: [] };
  write(root, REG, `${JSON.stringify(unrelated)}${NL}`);
  const w = must(await writeRisks(root, fix));
  assert.match(msgOf(w), /第 1 行/);
  assert.match(msgOf(w), /旧格式/);
  assert.ok(!msgOf(w).includes(OLD), '不回显原文');
});

test('M5 close 的输出按文件列出增删行数（PR #46 第 1 轮代码 M5、一致性 M6）', async () => {
  const { root } = midRounds();
  const { head } = await fixAndRecord(root, 3);
  const c = must(await closeRound(root, head));
  assert.match(msgOf(c), /src\/dedup\.ts：\+\d+ -\d+/);
  assert.match(msgOf(c), /review-risks\.jsonl：\+\d+ -\d+/);
});

test('M5 显示用的路径把制表符、换行等控制字符转义，一条路径只占一行；含制表符的文件名完整保留并带上增删行数（PR #46 第 1 轮代码 M5、一致性 M6）', { skip: process.platform === 'win32' && 'Windows 的文件名不能含制表符和换行' }, () => {
  assert.equal(REVIEW.displayPath('a\tb\nc\\d'), String.raw`a\tb\nc\\d`);
  assert.equal(REVIEW.displayPath('src/普通.ts'), 'src/普通.ts');
  const { root, c2 } = midRounds();
  write(root, 'test/a\tb.ts', `x${NL}y${NL}`);
  commitAll(root, 'tab path');
  const lines = REVIEW.fixDiffLines(root, c2, headOf(root));
  assert.ok(lines.includes(String.raw`  test/a\tb.ts：+2 -0`), lines.join(' / '));
});

test('M5 displayPath 在各平台都转义控制字符（PR #46 第 1 轮代码 M5）', () => {
  assert.equal(REVIEW.displayPath('x\u001by'), String.raw`x\u001by`);
  assert.equal(REVIEW.displayPath('a\rb'), String.raw`a\rb`);
  assert.equal(REVIEW.displayPath('a\\b'), String.raw`a\\b`, '反斜杠本身也转义，转义后的写法不会和原样的反斜杠混淆');
});

// ---------- PR #46 第 2 轮复审的回归 ----------

test('M2 越权登记：第 N 轮收齐前经用户决定在别的提交上的登记带 outOfBand、不计入轮次；收齐后最后一轮的另一种审查要按最后一轮补登，补齐前不能收口（PR #46 第 2 轮代码 M2、一致性 M3）', async () => {
  const { root } = rcRepo();
  const a = addCommit(root, 1);
  must(reg(root, 'code', 'fail', a, [H(), M()]));
  must(reg(root, 'consistency', 'pass', a));
  const b = addCommit(root, 2);
  must(reg(root, 'code', 'fail', b, [H(), M()]));
  const d = addCommit(root, 3);
  const early = must(reg(root, 'consistency', 'pass', d, [], { userDecision: '用户同意先审 d' }));
  assert.equal(early.record.outOfBand, true, '越权登记带标记');
  assert.match(early.message, /越权/);
  // 第 2 轮的 b 仍缺一致性审：照常在 b 上补登（迟到的那份针对 b，PR 的最终提交暂时回到 b）
  const late = must(reg(root, 'consistency', 'pass', b, [], { prHead: b }));
  assert.equal(late.record.outOfBand, undefined, '按规则的登记不带标记');
  // 最后一轮在 d 上：代码复审只剩中级；提前的那份一致性审不算，阶段是收齐前
  must(reg(root, 'code', 'fail', d, [M()]));
  const fix = fixCommit(root, 4);
  const rows = logRows(root).length;
  const refused = await closeRound(root, fix);
  assertCloseRefused(root, refused, rows);
  assert.match(msgOf(refused), /collecting/);
  // 在 d 上按最后一轮补登一致性审（不要用户决定），之后修复、写风险登记、收口
  must(reg(root, 'consistency', 'pass', d, [], { prHead: d }));
  must(await writeRisks(root, fix));
  commitAll(root, 'risks');
  must(await closeRound(root, headOf(root)));
});

test('M8 risks 写风险登记失败时把本机申报恢复原样，不留下互相对不上的两份文件；重跑成功（PR #46 第 2 轮代码 M8）', async () => {
  const { root } = midRounds();
  const fix = fixCommit(root, 3);
  const declared = path.join(prDir(root), 'risks.json');
  assert.equal(fs.existsSync(declared), false);
  const original = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to).endsWith('review-risks.jsonl')) throw Object.assign(new Error('注入的风险登记写入失败（测试）'), { code: 'EIO' });
    return original(from, to);
  };
  let failed;
  try { failed = await writeRisks(root, fix).catch((e) => ({ ok: false, message: e.message })); } finally { fs.renameSync = original; }
  assert.equal(failed.ok, false);
  assert.match(msgOf(failed), /注入的风险登记写入失败/);
  assert.equal(fs.existsSync(declared), false, '申报恢复成写之前的样子（原来没有）');
  assert.equal(fs.existsSync(path.join(root, REG)), false);
  must(await writeRisks(root, fix));
  assert.ok(fs.existsSync(declared));
});

test('M7 风险登记或它的历史里有旧格式行时，risks 提示推送前检查还没推送的提交；close 成功时提示最终提交上仍有的旧格式行号（PR #46 第 2 轮代码 M7、一致性 M5）', async () => {
  const { root } = midRounds();
  const fix = fixCommit(root, 3);
  const unrelated = { pr: '3', commit: 'a'.repeat(40), round: 1, kind: 'code', id: 'M5', severity: 'medium', location: 'src/x.ts:1', problem: '无关旧行的原文', reason: '理由', fix: '改法', status: '已修、未再复审', fixedIn: [] };
  write(root, REG, `${JSON.stringify(unrelated)}${NL}`);
  const w = must(await writeRisks(root, fix));
  assert.match(msgOf(w), /git log -p/);
  assert.match(msgOf(w), /推送/);
  commitAll(root, 'risks');
  const c = must(await closeRound(root, headOf(root)));
  assert.match(msgOf(c), /第 1 行仍是旧格式/);
  assert.ok(!msgOf(c).includes('无关旧行的原文'));
});
