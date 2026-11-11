// PR 双审与合并入口测试（复审流程 reviewFlow 为 pr）：推送核对不要求复审记录、登记时核对 PR 与 CI、
// 合并前核对两项审查绑定最终提交、gh 失败不放行、同步与回滚。对应功能契约 contract-pr-review-merge.md 的验收标准。
// gh 一律用假的实现注入，不访问网络；git 状态用临时仓库真实运行。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { normalizeConfig, toFlat, toProfile } from '../gate/config.mjs';
import { runGate } from '../gate/gate.mjs';
import { readRecord } from '../gate/lib.mjs';
import { mergePr } from '../gate/merge.mjs';
import { recordReview } from '../gate/review.mjs';
import { runSmoke } from '../gate/smoke.mjs';
import { verify } from '../gate/verify.mjs';
import { classify } from '../hooks/pre-bash.mjs';
import { BUNDLE_ROOT, extractTag, syncKit } from '../sync.mjs';
import { commitAll, featureRepo, git, read, reportFile, SRC_HEADER, tmpRepo, write } from './helpers.mjs';

/** 一个合格的复审报告：字数够、含“结论”、结论为通过。 */
const GOOD_REPORT = `发现：无高、中级问题。\n已逐条核对 PR 的最终提交，dedup 函数与测试用例的边界条件（空数组、重复项）均有覆盖。\n处置：无需处理。\n结论\n通过\n`;

/** PR 的两个最终提交（复审时的、复审后又推送的）。 */
const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);

/** 全部通过的检查：成功、提交状态成功、跳过、中性。 */
const GREEN = [
  { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { __typename: 'StatusContext', context: 'lint', state: 'SUCCESS' },
  { __typename: 'CheckRun', name: 'e2e', status: 'COMPLETED', conclusion: 'SKIPPED' },
  { __typename: 'CheckRun', name: 'info', status: 'COMPLETED', conclusion: 'NEUTRAL' },
];

/** gh pr view 的输出。 */
function prView({ state = 'OPEN', head = HEAD, checks = GREEN, files = ['src/dedup.ts', 'test/dedup.test.ts'] } = {}) {
  return { state, headRefOid: head, statusCheckRollup: checks, files: files.map((p) => ({ path: p, additions: 1, deletions: 0 })) };
}

/** 假的 gh：pr view 返回给定 PR，其余命令成功；所有调用记在 calls 里。 */
function fakeGh(view) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[1] === 'view') return { status: 0, stdout: JSON.stringify(view), stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  gh.calls = calls;
  return gh;
}

/** 合并命令是否被调用过。 */
const merged = (gh) => gh.calls.some((a) => a[1] === 'merge');

/** 配置为 pr 流程的功能分支仓库。 */
const prRepo = () => featureRepo({ reviewFlow: 'pr' });

/** 登记一项审查（pass/fail 带合格报告，defer 带理由）。 */
function register(root, gh, kind, verdict = 'pass', extra = {}) {
  const base = { root, verdict, pr: '7', kind, gh, ...extra };
  if (verdict === 'defer') return recordReview({ reason: '低风险小改动，并入本周巡检', ...base });
  return recordReview({ reviewer: 'feature-dev:code-reviewer', reportPath: reportFile(GOOD_REPORT), summary: 's', ...base });
}

// 验收 1 由现有 pre-push 测试覆盖；这里补“pre-push 项目不受新参数影响”。
test('pre-push 流程：不接受 --pr，合并入口报错说明未启用 pr 流程', () => {
  const root = featureRepo();
  const gh = fakeGh(prView());
  assert.match(register(root, gh, 'code').message, /pre-push/);
  assert.throws(() => mergePr({ root, pr: '7', gh }), /未启用 pr 流程/);
  assert.equal(gh.calls.length, 0, 'pre-push 项目不应调用 gh');
});

test('配置：reviewFlow 默认 pre-push，只认 pre-push 与 pr；扁平回滚再升级不丢失', () => {
  assert.equal(normalizeConfig({ profile: 2 }).reviewFlow, 'pre-push');
  assert.equal(normalizeConfig({}).reviewFlow, 'pre-push');
  assert.throws(() => normalizeConfig({ profile: 2, modules: { gate: { reviewFlow: 'post-merge' } } }), /reviewFlow/);
  assert.throws(() => normalizeConfig({ reviewFlow: 'PR' }), /reviewFlow/);
  const prof = toProfile({ reviewFlow: 'pr' });
  assert.equal(prof.modules.gate.reviewFlow, 'pr');
  const flat = toFlat(prof);
  assert.equal(flat.reviewFlow, 'pr');
  assert.equal(toProfile(flat).modules.gate.reviewFlow, 'pr');
});

test('验收 2：pr 流程推送核对——有通过的测试记录、没有复审记录即通过', () => {
  const root = prRepo();
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return [...new Set(items)].sort();\n}\n`);
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nassert.ok(dedup, 'sorted');\n");
  assert.equal(runGate({ root }).ok, true);
  commitAll(root, 'feat: dedup sorted');
  assert.equal(readRecord(root, 'review.json'), null);
  const res = verify({ root });
  assert.equal(res.ok, true, JSON.stringify(res.problems));
  // 测试记录仍然必需
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return items;\n}\n`);
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nassert.ok(dedup, 'plain');\n");
  commitAll(root, 'feat: plain');
  assert.equal(verify({ root }).ok, false, '代码变化后测试记录失效，仍应拒绝');
});

test('验收 3：CI 有检查失败、仍在运行、或一项检查都没有时拒绝登记', () => {
  const cases = [
    [...GREEN, { __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' }],
    [...GREEN, { __typename: 'CheckRun', name: 'unit', status: 'IN_PROGRESS', conclusion: '' }],
    [...GREEN, { __typename: 'StatusContext', context: 'deploy', state: 'PENDING' }],
    [],
  ];
  for (const checks of cases) {
    const root = prRepo();
    const r = register(root, fakeGh(prView({ checks })), 'code');
    assert.equal(r.ok, false, JSON.stringify(checks));
    assert.match(r.message, /CI/);
    assert.equal(fs.existsSync(path.join(root, '.git', 'engineering-gate', 'pr', '7', 'code.json')), false, '拒绝时不写记录');
  }
});

test('验收 4：PR 已关闭或已合并时拒绝登记', () => {
  for (const state of ['CLOSED', 'MERGED']) {
    const r = register(prRepo(), fakeGh(prView({ state })), 'code');
    assert.equal(r.ok, false);
    assert.match(r.message, /不是打开状态/);
  }
});

test('登记：报告与复审者检查对 pr 流程照常生效；defer 只限一致性审且须写理由', () => {
  const root = prRepo();
  const gh = fakeGh(prView());
  assert.match(register(root, gh, 'code', 'pass', { reviewer: 'me-myself' }).message, /复审者/);
  assert.match(register(root, gh, 'code', 'pass', { reportPath: reportFile('结论\n通过\n') }).message, /不少于/);
  assert.match(register(root, gh, 'code', 'pass', { reportPath: reportFile(GOOD_REPORT.replace('通过\n', '不通过\n')) }).message, /不通过/);
  assert.match(register(root, gh, 'code', 'defer').message, /只有一致性审可以延期/);
  assert.match(register(root, gh, 'consistency', 'defer', { reason: ' ' }).message, /--reason/);
  assert.match(register(root, gh, 'tests').message, /--kind/);
  assert.throws(() => register(root, gh, 'code', 'pass', { pr: '../x' }), /PR 编号不合法/);
});

test('验收 5：两项审查都 pass、提交一致、CI 全过时合并，并带 --match-head-commit；记录在公共目录，跨工作树可见', () => {
  const root = prRepo();
  const gh = fakeGh(prView());
  assert.equal(register(root, gh, 'code').ok, true);
  assert.equal(register(root, gh, 'consistency').ok, true);
  const rec = JSON.parse(read(root, '.git/engineering-gate/pr/7/code.json'));
  assert.equal(rec.headSha, HEAD);
  assert.equal(rec.verdict, 'pass');
  assert.equal(rec.reviewer, 'feature-dev:code-reviewer');
  assert.ok(fs.existsSync(rec.report), '报告副本应已保存');
  assert.ok(rec.at);

  const wt = `${root}-wt`;
  git(root, ['worktree', 'add', '-q', '-b', 'merge-from-here', wt]);
  const res = mergePr({ root: wt, pr: '7', gh });
  assert.equal(res.ok, true, JSON.stringify(res.problems));
  assert.deepEqual(gh.calls.at(-1), ['pr', 'merge', '7', '--squash', '--match-head-commit', HEAD, '--delete-branch']);
});

test('验收 5（延期）：一致性审为写明理由的 defer 时也可合并；--method 改合并方式', () => {
  const root = prRepo();
  const gh = fakeGh(prView());
  register(root, gh, 'code');
  const d = register(root, gh, 'consistency', 'defer');
  assert.equal(d.ok, true, d.message);
  assert.equal(d.record.reason, '低风险小改动，并入本周巡检');
  assert.equal(d.record.headSha, HEAD);
  assert.equal(mergePr({ root, pr: '7', method: 'rebase', gh }).ok, true);
  assert.deepEqual(gh.calls.at(-1), ['pr', 'merge', '7', '--rebase', '--match-head-commit', HEAD, '--delete-branch']);
  assert.throws(() => mergePr({ root, pr: '7', method: 'fast-forward', gh }), /合并方式/);
});

test('验收 6：复审后 PR 又有新提交时拒绝合并，并指出哪份记录过期', () => {
  const root = prRepo();
  register(root, fakeGh(prView()), 'code');
  register(root, fakeGh(prView()), 'consistency');
  const gh = fakeGh(prView({ head: NEW_HEAD }));
  const res = mergePr({ root, pr: '7', gh });
  assert.equal(res.ok, false);
  assert.ok(res.problems.some((p) => p.startsWith('代码复审记录已过期') && p.includes(NEW_HEAD.slice(0, 12))), res.problems.join('\n'));
  assert.ok(res.problems.some((p) => p.startsWith('一致性审记录已过期')), res.problems.join('\n'));
  assert.equal(merged(gh), false);
});

test('验收 7：缺少任一审查记录，或其中一份结论为 fail 时拒绝合并', () => {
  const root = prRepo();
  const gh = fakeGh(prView());
  register(root, gh, 'code');
  let res = mergePr({ root, pr: '7', gh });
  assert.equal(res.ok, false);
  assert.ok(res.problems.some((p) => p.includes('缺少一致性审记录')), res.problems.join('\n'));

  register(root, gh, 'consistency');
  const f = register(root, gh, 'code', 'fail', { reportPath: reportFile(GOOD_REPORT.replace('通过\n', '不通过\n')) });
  assert.equal(f.ok, true, f.message);
  res = mergePr({ root, pr: '7', gh });
  assert.equal(res.ok, false);
  assert.ok(res.problems.some((p) => p.includes('代码复审结论是 fail')), res.problems.join('\n'));
  assert.equal(merged(gh), false);

  const empty = prRepo();
  res = mergePr({ root: empty, pr: '7', gh });
  assert.ok(res.problems.some((p) => p.includes('缺少代码复审记录')));
});

test('验收 8：CI 在当前最终提交上未全过时拒绝合并（PR 已关闭也拒绝）', () => {
  const root = prRepo();
  register(root, fakeGh(prView()), 'code');
  register(root, fakeGh(prView()), 'consistency');
  for (const view of [
    prView({ checks: [...GREEN, { __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' }] }),
    prView({ checks: [] }),
    prView({ state: 'CLOSED' }),
  ]) {
    const gh = fakeGh(view);
    const res = mergePr({ root, pr: '7', gh });
    assert.equal(res.ok, false, JSON.stringify(view));
    assert.equal(merged(gh), false);
  }
});

test('验收 9：gh 不存在或调用失败时，登记与合并都报错，不放行', () => {
  const missing = () => ({ error: new Error('spawn gh ENOENT'), status: null });
  const failing = () => ({ status: 1, stdout: '', stderr: 'HTTP 401' });
  const badJson = () => ({ status: 0, stdout: '不是 json' });
  for (const gh of [missing, failing, badJson]) {
    const root = prRepo();
    assert.throws(() => register(root, gh, 'code'), /gh/);
    assert.throws(() => mergePr({ root, pr: '7', gh }), /gh/);
  }
  // 核对全部通过、但 gh pr merge 本身失败：报错，不报告“已合并”
  const root = prRepo();
  const ok = fakeGh(prView());
  register(root, ok, 'code');
  register(root, ok, 'consistency');
  const mergeFails = (args) => (args[1] === 'merge' ? { status: 1, stderr: 'Head branch was modified' } : ok(args));
  assert.throws(() => mergePr({ root, pr: '7', gh: mergeFails }), /gh pr merge 失败/);
});

test('钩子：直接 gh pr merge 被拒并指向 merge.mjs；merge.mjs 这条命令本身不被拦', () => {
  assert.equal(classify('node scripts/engineering/gate/merge.mjs 12'), 'other');
  assert.equal(classify('node "D:/proj/scripts/engineering/gate/merge.mjs" 12 --method rebase'), 'other');
  const hook = path.join(BUNDLE_ROOT, 'kit', 'hooks', 'pre-bash.mjs');
  const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_input: { command: 'gh pr merge 12 --squash' } }), encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /node scripts\/engineering\/gate\/merge\.mjs <PR>/);
});

test('验收 10：pr 流程项目同步后有 merge.mjs、冒烟通过；回滚到 0.2.2 后旧流程可用，再升级 reviewFlow 仍在', async () => {
  const root = tmpRepo();
  const cfg = JSON.parse(read(BUNDLE_ROOT, 'kit/templates/engineering.config.json'));
  cfg.modules.gate.reviewFlow = 'pr';
  write(root, 'engineering.config.json', JSON.stringify(cfg, null, 2));
  write(root, 'README.md', '# 项目\n');
  commitAll(root, 'base');
  const r = syncKit({ target: root });
  assert.equal(r.ok, true, r.messages.join('\n'));
  assert.ok(fs.existsSync(path.join(root, 'scripts/engineering/gate/merge.mjs')), '同步后应有合并入口');
  assert.deepEqual(await runSmoke(root), []);

  const tag = 'engineering-kit-v0.2.2';
  if (spawnSync('git', ['-C', BUNDLE_ROOT, 'rev-parse', '--verify', '--quiet', `${tag}^{commit}`]).status !== 0) return; // 没有该标签的克隆里跳过回滚部分
  const old = extractTag(tag);
  try {
    const back = syncKit({ target: root, bundleRoot: old });
    assert.equal(back.ok, true, back.messages.join('\n'));
  } finally {
    fs.rmSync(old, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(path.join(root, 'scripts/engineering/gate/merge.mjs')), false, '旧版本没有合并入口');
  assert.equal(JSON.parse(read(root, 'engineering.config.json')).modules.gate.reviewFlow, 'pr', '项目配置取值保留');
  // 旧流程：推送核对要求复审记录
  commitAll(root, 'kit 0.2.2');
  git(root, ['checkout', '-q', '-b', 'feat']);
  write(root, 'tool.mjs', '// 小工具\n');
  commitAll(root, 'tool');
  const v = spawnSync(process.execPath, [path.join(root, 'scripts/engineering/gate/verify.mjs')], { cwd: root, encoding: 'utf8' });
  assert.equal(v.status, 1);
  assert.match(v.stderr, /没有复审记录/);
  // 再升级回当前版本
  git(root, ['checkout', '-q', 'main']);
  assert.equal(syncKit({ target: root }).ok, true);
  assert.equal(JSON.parse(read(root, 'engineering.config.json')).modules.gate.reviewFlow, 'pr');
});

test('只改文档的 PR：没有任何审查记录、CI 全过时合并；CI 未过时拒绝', () => {
  // 0.6.0 起“只改文档”按本地差异判定：PR 的最终提交要在临时仓库里真的存在
  const root = prRepo();
  const docs = ['README.md', 'docs/04-开发/note.md'];
  for (const f of docs) write(root, f, '说明\n');
  commitAll(root, 'docs');
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const gh = fakeGh(prView({ files: docs, head }));
  const res = mergePr({ root, pr: '7', gh });
  assert.equal(res.ok, true, JSON.stringify(res.problems));
  assert.deepEqual(gh.calls.at(-1), ['pr', 'merge', '7', '--squash', '--match-head-commit', head, '--delete-branch']);

  const red = fakeGh(prView({ files: docs, head, checks: [...GREEN, { __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' }] }));
  const r2 = mergePr({ root, pr: '7', gh: red });
  assert.equal(r2.ok, false);
  assert.ok(r2.problems.some((p) => p.includes('CI 检查未通过')), r2.problems.join('\n'));
  assert.equal(merged(red), false);
});

test('文档与代码混合的 PR 没有审查记录时拒绝合并', () => {
  // 0.6.0 起按本地差异判定，混合改动在临时仓库里真的提交出来（否则最终提交不在本地，结论不说明问题）
  const root = prRepo();
  write(root, 'README.md', '# 说明\n');
  write(root, 'src/dedup.ts', `${SRC_HEADER}export const x = 1;\n`);
  commitAll(root, 'mixed');
  const gh = fakeGh(prView({ files: ['README.md', 'src/dedup.ts'], head: git(root, ['rev-parse', 'HEAD']).trim() }));
  const res = mergePr({ root, pr: '7', gh });
  assert.equal(res.ok, false);
  assert.ok(res.problems.some((p) => p.includes('缺少代码复审记录')), res.problems.join('\n'));
  assert.equal(merged(gh), false);
});

test('本地没有 PR 最终提交、或本地差异为空时不按只改文档处理（gh 的文件列表不作依据）', () => {
  // 0.6.0 前这里测的是 gh 文件列表为空或达到 100 个；现在 gh 的列表不再作为“只改文档”的依据，改测两种算不出或为空的本地情况
  const docs = Array.from({ length: 3 }, (_, i) => `docs/n${i}.md`);
  const gh = fakeGh(prView({ files: docs })); // 最终提交 a…a 不在本地
  const res = mergePr({ root: prRepo(), pr: '7', gh });
  assert.equal(res.ok, false);
  assert.ok(res.problems.some((p) => p.includes('缺少代码复审记录')), res.problems.join('\n'));
  assert.equal(merged(gh), false);

  const root = prRepo(); // 功能分支上没有任何提交：最终提交就是基准提交，差异为空
  const empty = fakeGh(prView({ files: docs, head: git(root, ['rev-parse', 'HEAD']).trim() }));
  const r2 = mergePr({ root, pr: '7', gh: empty });
  assert.equal(r2.ok, false);
  assert.ok(r2.problems.some((p) => p.includes('缺少代码复审记录')), r2.problems.join('\n'));
  assert.equal(merged(empty), false);
});
