// 外部复审与轮次收口：final-next 阶段的运行带“最后一轮”要求（请求里 review.finalRound、提示词含 FINAL_ROUND_TEXT），
// close-only 与 stop 阶段在启动执行器之前就拒绝。假执行器、假 gh、真实 git 临时仓库；不调用任何真实模型，不访问网络。
// 假执行器与 gh 的写法取自 external-review.test.mjs（那个文件不改）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runExternalReview } from '../gate/external-review.mjs';
import { recordReview } from '../gate/review.mjs';
import { FINAL_ROUND_TEXT } from '../gate/review-rounds.mjs';
import { commitAll, featureRepo, finding, git, reviewData, reviewDataFile, tmpDir, write } from './helpers.mjs';

const NL = String.fromCharCode(10);
const NARRATIVE = '检查了 src/dedup.ts 与 src/auth.ts 的全部改动，逐个核对了导出函数的输入校验、边界条件（空数组、重复项、非法输入）、错误处理和对应的测试用例，并对照了仓库里的调用方，确认改动没有改变既有行为。';

/** 假执行器：读任务、总是交回通过的结论（遵守协议 2）。 */
const FAKE = `
import fs from 'node:fs';
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const req = JSON.parse(Buffer.concat(chunks).toString('utf8'));
fs.mkdirSync(process.env.EK_EXTERNAL_REVIEW_RAW_DIR, { recursive: true });
const base = { version: 2, execution: { status: 'completed' }, provenance: { executor: 'fake', requestedModel: req.model.id, actualModel: req.model.id }, usage: { tokens: { input_tokens: 10, output_tokens: 5 }, credits: 0.5 } };
process.stdout.write(JSON.stringify({ ...base, review: { verdict: 'pass', findings: [], testGaps: null, dispositions: [], limitations: [], report: ${JSON.stringify(NARRATIVE)} } }));
`;
const fakePath = path.join(tmpDir('ekit-fake-exec-'), 'fake.mjs');
fs.writeFileSync(fakePath, FAKE);
const LOCAL = { file: '(测试)', executors: { fake: { type: 'protocol', command: [process.execPath, fakePath], defaultModel: 'fake-model-1' } } };

const GREEN = [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }];
function fakeGh(head) {
  return (args) => {
    if (args[1] === 'view') return { status: 0, stdout: JSON.stringify({ state: 'OPEN', headRefOid: head, statusCheckRollup: GREEN }), stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
}

/** pr 流程、上限 1 轮的仓库；closure 为 false 时不开收口。返回 { root, head, main }。 */
function repo({ closure = true } = {}) {
  const root = featureRepo({ reviewFlow: 'pr', reviewMinChars: 0, maxReviewRounds: 1, reviewers: ['feature-dev:code-reviewer', 'external:fake'], externalExecutors: ['fake'], ...(closure ? { roundClosure: 'fix-and-record' } : {}) });
  write(root, 'src/auth.ts', ['// 权限模块：删除记录前校验所有者。', 'export function canDelete() {', '  return true;', '}', ''].join(NL));
  commitAll(root, 'feat');
  return { root, head: git(root, ['rev-parse', 'HEAD']).trim(), main: git(root, ['rev-parse', 'main']).trim() };
}
/** 在功能分支上再提交一处改动，返回新的最终提交。 */
function nextHead(root, tag) {
  write(root, 'src/auth.ts', ['// 权限模块：删除记录前校验所有者。', 'export function canDelete(user: string) {', `  return user.length > ${tag.length}; // ${tag}`, '}', ''].join(NL));
  commitAll(root, tag);
  return git(root, ['rev-parse', 'HEAD']).trim();
}

/** 手工登记一份复审（PR 7）。 */
function reg(root, main, kind, verdict, head, findings = [], dispositions = []) {
  const d = reviewData({ kind, verdict, findings, reviewedCommit: head, reviewedBase: main, dispositions });
  const r = recordReview({ root, verdict, reviewer: 'feature-dev:code-reviewer', reportPath: reviewDataFile(d), summary: 's', pr: '7', kind, gh: fakeGh(head) });
  assert.equal(r.ok, true, r.message);
}
/** 第 1 轮（上限 1 轮）：代码复审 fail 带给定发现，一致性审 pass。 */
function firstRound(root, main, head, findings) {
  reg(root, main, 'code', 'fail', head, findings);
  reg(root, main, 'consistency', 'pass', head);
}

/** 跑一次外部复审；把“拒绝”统一成 { ok, message }（可以抛错，也可以返回 ok:false）。 */
async function run(root, head, outDir, extra = {}) {
  try {
    const r = await runExternalReview({ root, executor: 'fake', pr: '7', gh: fakeGh(head), localConfig: LOCAL, outDir, ...extra });
    return { ok: r.ok !== false, message: r.message ?? '', res: r };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}
const freshOut = () => path.join(tmpDir('ekit-xr-'), 'run');
const requestOf = (res) => JSON.parse(fs.readFileSync(path.join(res.runDir, 'request.json'), 'utf8'));

test('A7 final-next（第 1 轮有高级，上限 1）：新提交上的外部复审带最后一轮要求，请求、提示词、报告都写明', async () => {
  const { root, head, main } = repo();
  firstRound(root, main, head, [finding({ id: 'H1', severity: 'high' }), finding({ id: 'M1' })]);
  const next = nextHead(root, 'fix1');
  const r = await run(root, next, freshOut());
  assert.equal(r.ok, true, r.message);
  const request = requestOf(r.res);
  assert.equal(request.review.finalRound, true);
  assert.ok(request.context.instructions.includes(FINAL_ROUND_TEXT), '提示词含最后一轮的要求');
  const shown = ['report.md', 'review.json', 'assessment.json'].map((f) => path.join(r.res.runDir, f)).filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf8')).join(NL);
  assert.match(shown, /最后一轮/, '报告元信息写明最后一轮');
});

test('A7 final-next 且 finalHead 已定（别的审查已在新提交上登记）：在 finalHead 上的外部复审同样带最后一轮要求', async () => {
  const { root, head, main } = repo();
  firstRound(root, main, head, [finding({ id: 'H1', severity: 'high' })]);
  const next = nextHead(root, 'fix1');
  reg(root, main, 'code', 'pass', next, [], [{ id: 'H1', status: 'fixed', evidence: '已修并补了测试。' }]);
  const r = await run(root, next, freshOut(), { kind: 'consistency' });
  assert.equal(r.ok, true, r.message);
  assert.equal(requestOf(r.res).review.finalRound, true);
  assert.ok(requestOf(r.res).context.instructions.includes(FINAL_ROUND_TEXT));
});

test('A7 第 1 轮还没到上限（open）或收口关闭：不带最后一轮要求', async () => {
  const off = repo({ closure: false });
  firstRound(off.root, off.main, off.head, [finding({ id: 'H1', severity: 'high' })]);
  const offRun = await run(off.root, nextHead(off.root, 'fix1'), freshOut());
  assert.equal(offRun.ok, true, offRun.message);
  assert.notEqual(requestOf(offRun.res).review.finalRound, true);
  assert.ok(!requestOf(offRun.res).context.instructions.includes(FINAL_ROUND_TEXT));
  const { root } = repo();
  const next = nextHead(root, 'fix2');
  const open = await run(root, next, freshOut());
  assert.equal(open.ok, true, open.message);
  assert.notEqual(requestOf(open.res).review.finalRound, true, '还没有任何一轮');
  assert.ok(!requestOf(open.res).context.instructions.includes(FINAL_ROUND_TEXT));
});

test('A6 close-only（第 1 轮只剩中级，上限 1）：外部复审在启动执行器前被拒，指向 close，没有建运行目录', async () => {
  const { root, head, main } = repo();
  firstRound(root, main, head, [finding({ id: 'M1' })]);
  const next = nextHead(root, 'fix1');
  const out = freshOut();
  const r = await run(root, next, out);
  assert.equal(r.ok, false);
  assert.match(r.message, /close/);
  assert.equal(fs.existsSync(out), false, '被拒时没有建运行目录，执行器没有启动');
});

test('A8 / A10 stop（发现无法彻底解决）：外部复审在启动执行器前被拒，写明停下与 --user-decision', async () => {
  const { root, head, main } = repo();
  firstRound(root, main, head, [finding({ id: 'M1', unresolvable: true })]);
  const next = nextHead(root, 'fix1');
  const out = freshOut();
  const r = await run(root, next, out);
  assert.equal(r.ok, false);
  assert.match(r.message, /停下/);
  assert.match(r.message, /--user-decision/);
  assert.equal(fs.existsSync(out), false, '被拒时没有建运行目录');
});
