// 轮次收口集成测试（契约 A3、A6–A9、A11、A12）：featureRepo 配成 pr 流程、收口 fix-and-record、上限 2 轮，
// 用假 gh 和真实提交，走 review.mjs 的 recordReview（含 close）与 merge.mjs 的 mergePr。
// 业务含义：两轮之后只剩中、低级时不再加轮，作者修完、把问题写进风险登记，用 close 登记；合并入口认 close，CI 仍须全过；
// 有高级则开放最后一轮，最后一轮后仍有高级或“无法彻底解决”就停下向用户汇报。默认关闭时行为与旧版完全一致。
// 约定（见交回说明）：close 记录在 .git/engineering-gate/pr/<编号>/close.json；合并结果的 notes 数组里写“收口”；
// 拒绝文案里的关键词（轮次、高级、最新一轮、风险登记、打开、CI、最终提交、向用户汇报、专项、review.mjs close、--final-round、未开启）按契约与计划的写法。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { mergePr } from '../gate/merge.mjs';
import { recordReview } from '../gate/review.mjs';
import { commitAll, featureRepo, git, read, reportFile, SRC_HEADER, write } from './helpers.mjs';

const RISK = 'docs/04-开发/review-risks.md';
const PASS_TEXT = '## 范围\n读了 dedup 函数、调用方和测试。\n\n## 发现\n无高、中级问题。\n\n## 作者的验证\n核对了作者给出的测试输出，没有重跑。\n\n## 结论\n通过。无高、中级问题。\n';
const HEAD7 = '| 编号 | 级别 | 位置 | 问题 | 触发条件或例子 | 理由 | 建议改法 |\n|---|---|---|---|---|---|---|';
/** 一行发现；over 里可覆盖理由、建议改法。 */
const fr = (id, sev, over = {}) => `| ${id} | ${sev} | src/dedup.ts:3 | ${over.problem ?? '去重丢顺序'} | 输入含重复项 | ${over.reason ?? '改变调用方看到的顺序，影响展示'} | ${over.fix ?? '改用保序去重'} |`;
/** 带发现表的 fail 报告。 */
const failText = (rows) => `## 范围\n读了 dedup 函数、调用方和测试。\n\n## 发现\n\n${HEAD7}\n${rows.join('\n')}\n\n## 作者的验证\n核对了作者给出的测试输出，没有重跑。\n\n## 结论\n不通过。H1 未修复。\n`;
/** 没有发现表、只用文字写发现的 fail 报告。 */
const NO_TABLE = '## 范围\n读了 dedup 函数、调用方和对应的测试文件。\n\n## 发现\nH1 未修复：删除接口越权，这里没有写成表。\n\n## 作者的验证\n核对了作者给出的测试输出，没有重跑。\n\n## 结论\n不通过。H1 未修复。\n';
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file, 'utf8')).digest('hex');

/** 风险登记表的一行（中级、已修未再复审，可覆盖栏位）。 */
const regRow = (id, head, round, over = {}) => `| ${id} | ${over.pr ?? '#7'} | ${head.slice(0, over.len ?? 12)} | ${round} | 中 | src/dedup.ts:3 | 去重丢顺序 | 改变调用方看到的顺序，影响展示 | 改用保序去重 | ${over.status ?? '已修、未再复审'} |`;
const regFile = (rows) => `# 复审风险登记\n\n| 编号 | PR | 提交 | 轮次 | 级别 | 位置 | 问题 | 理由 | 推荐措施 | 状态 |\n|---|---|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n`;

/** 打开的 PR、CI 可调（state、conclusion），head 随提交变；记录 merge 调用。 */
function ghFor(st) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[1] === 'view') {
      const view = {
        state: st.state,
        headRefOid: st.head,
        statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: st.conclusion }],
        files: [{ path: 'src/dedup.ts' }],
      };
      return { status: 0, stdout: JSON.stringify(view), stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  gh.calls = calls;
  return gh;
}
const merged = (gh) => gh.calls.some((a) => a[1] === 'merge');

/** 收口开启（上限 2）的 pr 流程环境；config 可覆盖。 */
function env(config = {}) {
  const root = featureRepo({ reviewFlow: 'pr', roundClosure: 'fix-and-record', maxReviewRounds: 2, ...config });
  const st = { head: null, state: 'OPEN', conclusion: 'SUCCESS' };
  return { root, st, gh: ghFor(st) };
}

/** 改一处代码并提交（可同时写别的文件），PR 的最终提交随之前进；返回新提交。 */
function commit(e, tag, also) {
  write(e.root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return [...new Set(items)]; // ${tag}\n}\n`);
  write(e.root, 'test/dedup.test.ts', `import { dedup } from '../src/dedup.ts';\nassert.ok(dedup, '${tag}');\n`);
  also?.();
  commitAll(e.root, tag);
  e.st.head = git(e.root, ['rev-parse', 'HEAD']).trim();
  return e.st.head;
}

/** 登记一份审查；报告文件路径挂在返回值的 path 上，供 close 的 --report 复用。 */
function reg(e, kind, verdict, text, extra = {}) {
  const reportPath = extra.reportPath ?? reportFile(text);
  const res = recordReview({ root: e.root, verdict, pr: '7', kind, gh: e.gh, reviewer: 'general-purpose', reportPath, summary: 's', ...extra });
  return Object.assign(res, { path: reportPath });
}

/** 新提交 + 代码复审 fail（rows）+ 一致性审 pass 或 fail（consRows，null 表示 pass）。返回 { head, code, cons }。 */
function round(e, tag, codeRows, consRows = null) {
  const head = commit(e, tag);
  const code = reg(e, 'code', 'fail', failText(codeRows));
  assert.equal(code.ok, true, code.message);
  const cons = consRows ? reg(e, 'consistency', 'fail', failText(consRows)) : reg(e, 'consistency', 'pass', PASS_TEXT);
  assert.equal(cons.ok, true, cons.message);
  return { head, code, cons };
}

/** 两轮之后的典型局面：第 1 轮有高级，第 2 轮代码复审 M1、一致性审 M2（都只剩中、低级）。 */
function twoRounds(e) {
  const r1 = round(e, 'r1', [fr('H1', '高'), fr('M1', '中')]);
  const r2 = round(e, 'r2', [fr('M1', '中'), fr('L1', '低')], [fr('M2', '中')]);
  return { r1, r2 };
}

/** 修完后的最终提交，附带风险登记（rows 为 null 时不写文件）。 */
const finish = (e, rows, tag = 'fix') => commit(e, tag, () => rows && write(e.root, RISK, regFile(rows)));
const close = (e, reportPath, extra = {}) => recordReview({ root: e.root, verdict: 'close', pr: '7', reportPath, summary: 'M1、M2 已修，未再复审', gh: e.gh, ...extra });
const closeJson = (e) => path.join(e.root, '.git', 'engineering-gate', 'pr', '7', 'close.json');

// ---------- A3 登记时的发现表检查 ----------

test('A3 登记拒绝：fail 报告里高、中级行缺理由或建议改法、或没有发现表，不写记录，并指出第几行（编号）缺哪一栏', () => {
  const cases = [
    [[fr('H1', '高', { reason: '' })], /第 1 行.{0,3}H1.{0,3}缺.*理由/],
    [[fr('M1', '中', { fix: '无' })], /第 1 行.{0,3}M1.{0,3}缺.*建议改法/],
    [[fr('M1', '中'), fr('H2', '高', { reason: '待补', fix: '-' })], /第 2 行.{0,3}H2.{0,3}缺.*理由.*建议改法/],
  ];
  for (const [rows, why] of cases) {
    const e = env();
    commit(e, 'r1');
    const r = reg(e, 'code', 'fail', failText(rows));
    assert.equal(r.ok, false, r.message);
    assert.match(r.message, why);
    assert.equal(fs.existsSync(path.join(e.root, '.git', 'engineering-gate', 'pr', '7', 'code.json')), false, '拒绝时不写记录');
  }
  // 没有发现表（只有“发现：…”文字）的 fail 报告
  const e = env();
  commit(e, 'r1');
  const noTable = reg(e, 'code', 'fail', NO_TABLE);
  assert.equal(noTable.ok, false);
  assert.match(noTable.message, /发现表/);
});

test('A3 登记放行：pass 报告的发现写“无”不查表；低级与提示行缺理由、建议改法不拦；accept 同样要有发现表', () => {
  const e = env();
  commit(e, 'r1');
  assert.equal(reg(e, 'code', 'pass', PASS_TEXT).ok, true, 'pass 报告发现写“无”放行');
  const lowOnly = reg(e, 'consistency', 'fail', failText([fr('M1', '中'), fr('L1', '低', { reason: '', fix: '' })]));
  assert.equal(lowOnly.ok, true, lowOnly.message);
  // accept：没有发现表拒绝，有合格的表放行
  const e2 = env();
  commit(e2, 'r1');
  const noTable = reg(e2, 'code', 'accept', NO_TABLE, { userDecision: '用户接受 H1（对话 2026-11-26）' });
  assert.equal(noTable.ok, false, noTable.message);
  assert.match(noTable.message, /发现表/);
  const withTable = reg(e2, 'code', 'accept', failText([fr('H1', '高')]), { userDecision: '用户接受 H1（对话 2026-11-26）' });
  assert.equal(withTable.ok, true, withTable.message);
});

test('A3 登记记录新增字段：round、reportSha（报告文本 sha256）、findings 统计；defer 的 reportSha 与 findings 为 null；日志里同样带上', () => {
  const e = env();
  commit(e, 'r1');
  const r = reg(e, 'code', 'fail', failText([fr('H1', '高'), fr('M1', '中'), fr('M2', '中'), fr('L1', '低')]));
  assert.equal(r.ok, true, r.message);
  assert.equal(r.record.round, 1);
  assert.equal(r.record.reportSha, sha256(r.path));
  assert.deepEqual(r.record.findings, { parsed: 4, high: 1, medium: 2, low: 1, info: 0, unresolvable: 0, highIds: ['H1'], mediumIds: ['M1', 'M2'] });
  const log = read(e.root, '.git/engineering-gate/pr/7/log.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.at(-1).round, 1);
  assert.equal(log.at(-1).reportSha, r.record.reportSha);
  assert.deepEqual(log.at(-1).findings, r.record.findings);
  // pass：报告文本的 sha256 也记；发现写“无”解析不出表时 findings 为 null
  const p = reg(e, 'consistency', 'pass', PASS_TEXT);
  assert.equal(p.record.reportSha, sha256(p.path));
  assert.equal(p.record.findings, null);
  assert.equal(p.record.round, 1, '同一份内容上另一种 kind 的登记仍在第 1 轮');
  const d = recordReview({ root: e.root, verdict: 'defer', pr: '7', kind: 'consistency', gh: e.gh, reason: '低风险，并入巡检' });
  assert.equal(d.ok, true, d.message);
  assert.equal(d.record.reportSha, null);
  assert.equal(d.record.findings, null);
  assert.equal(typeof d.record.round, 'number');
});

// ---------- A6 两轮后只剩中、低级：close ----------

test('A6 两轮后只剩中、低级：新内容上 pass、fail 都被拒并指向 close；--user-decision 仍可放行', () => {
  const e = env();
  twoRounds(e);
  commit(e, 'fix');
  for (const [verdict, text] of [['pass', PASS_TEXT], ['fail', failText([fr('M3', '中')])]]) {
    const r = reg(e, 'code', verdict, text);
    assert.equal(r.ok, false, verdict);
    assert.match(r.message, /review\.mjs close/, verdict);
  }
  const allowed = reg(e, 'code', 'pass', PASS_TEXT, { userDecision: '用户同意再审一轮（对话 2026-11-26）' });
  assert.equal(allowed.ok, true, allowed.message);
});

test('A6 close 成功：写风险登记并提交后，用最新一轮的 fail 报告登记 close；close.json 与日志字段齐全', () => {
  const e = env();
  const { r2 } = twoRounds(e);
  const final = finish(e, [regRow('M1', r2.head, 2), regRow('M2', r2.head, 2)]);
  const res = close(e, r2.code.path);
  assert.equal(res.ok, true, res.message);
  const rec = JSON.parse(fs.readFileSync(closeJson(e), 'utf8'));
  assert.equal(String(rec.pr), '7');
  assert.equal(rec.kind, 'close');
  assert.equal(rec.verdict, 'close');
  assert.equal(rec.reviewer, null);
  assert.equal(rec.headSha, final);
  assert.equal(rec.failHead, r2.head);
  assert.equal(rec.closedRound, 2);
  assert.equal(rec.riskRegister, RISK);
  assert.equal(rec.registerRows, 2);
  assert.deepEqual([...rec.mediumIds].sort(), ['M1', 'M2']);
  assert.equal(rec.summary, 'M1、M2 已修，未再复审');
  assert.ok(rec.at);
  const log = read(e.root, '.git/engineering-gate/pr/7/log.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.at(-1).kind, 'close');
  assert.equal(log.at(-1).verdict, 'close');
  // 用最新一轮另一份 fail 报告也可以（任一份）
  const again = close(e, r2.cons.path);
  assert.equal(again.ok, true, again.message);
});

test('A6 合并入口认 close：CI 全绿时放行，notes 写“收口”；CI 红仍拒绝', () => {
  const e = env();
  const { r2 } = twoRounds(e);
  const final = finish(e, [regRow('M1', r2.head, 2), regRow('M2', r2.head, 2)]);
  assert.equal(close(e, r2.code.path).ok, true);
  // 收口前合并：两项审查的记录针对更早的提交，应拒绝（用 CI 红来验证“CI 仍须全过”放在后面）
  e.st.conclusion = 'FAILURE';
  const red = mergePr({ root: e.root, pr: '7', gh: e.gh });
  assert.equal(red.ok, false, 'CI 红时收口也不放行');
  assert.equal(merged(e.gh), false);
  e.st.conclusion = 'SUCCESS';
  const res = mergePr({ root: e.root, pr: '7', gh: e.gh });
  assert.equal(res.ok, true, JSON.stringify(res.problems));
  assert.equal(merged(e.gh), true);
  assert.match(res.notes.join('\n'), /收口/);
  assert.deepEqual(e.gh.calls.at(-1).slice(0, 5), ['pr', 'merge', '7', '--squash', '--match-head-commit']);
  assert.equal(e.gh.calls.at(-1)[5], final);
});

test('A6 合并入口：没有 close 时，两轮后的新提交仍因审查记录过期被拒；close 之后又改了代码（最终提交变了）也不认', () => {
  const e = env();
  const { r2 } = twoRounds(e);
  finish(e, [regRow('M1', r2.head, 2), regRow('M2', r2.head, 2)]);
  const before = mergePr({ root: e.root, pr: '7', gh: e.gh });
  assert.equal(before.ok, false, '没有 close 不放行');
  assert.equal(close(e, r2.code.path).ok, true);
  commit(e, 'sneaky'); // close 之后又改了代码
  const after = mergePr({ root: e.root, pr: '7', gh: e.gh });
  assert.equal(after.ok, false);
  assert.equal(merged(e.gh), false);
});

// ---------- A7 第二轮有高级：最后一轮 ----------

test('A7 第 2 轮有高级：登记输出提示下一轮是最后一轮、修后复核用 --final-round；第 3 轮不要 --user-decision', () => {
  const e = env();
  round(e, 'r1', [fr('H1', '高')]);
  const head2 = commit(e, 'r2');
  const second = reg(e, 'code', 'fail', failText([fr('H2', '高'), fr('M1', '中')]));
  assert.equal(second.ok, true, second.message);
  assert.match(second.message, /最后一轮/);
  assert.match(second.message, /--final-round/);
  assert.equal(e.st.head, head2);
  commit(e, 'r3');
  const third = reg(e, 'code', 'fail', failText([fr('M1', '中')]));
  assert.equal(third.ok, true, third.message);
  assert.equal(third.record.round, 3);
  assert.equal(third.record.userDecision, undefined, '不需要用户决定');
  // pass 也放行
  const e2 = env();
  round(e2, 'r1', [fr('H1', '高')]);
  round(e2, 'r2', [fr('H2', '高')]);
  commit(e2, 'r3');
  assert.equal(reg(e2, 'code', 'pass', PASS_TEXT).ok, true);
});

// ---------- A8 最后一轮之后 ----------

test('A8 最后一轮仍有高级：新内容上 pass、fail 被拒，文案写向用户汇报与专项；带 --user-decision 放行', () => {
  const e = env();
  round(e, 'r1', [fr('H1', '高')]);
  round(e, 'r2', [fr('H2', '高')]);
  round(e, 'r3', [fr('H3', '高')]); // 最后一轮
  commit(e, 'r4');
  for (const [verdict, text] of [['pass', PASS_TEXT], ['fail', failText([fr('M1', '中')])]]) {
    const r = reg(e, 'code', verdict, text);
    assert.equal(r.ok, false, verdict);
    assert.match(r.message, /向用户汇报/);
    assert.match(r.message, /专项/);
    assert.match(r.message, /--user-decision/);
  }
  const allowed = reg(e, 'code', 'pass', PASS_TEXT, { userDecision: '用户决定再审一轮（对话 2026-11-26）' });
  assert.equal(allowed.ok, true, allowed.message);
});

test('A8 复审者认为无法彻底解决：即使没有高级也拒绝再登记，close 也不放行', () => {
  const e = env();
  round(e, 'r1', [fr('H1', '高')]);
  const r2 = round(e, 'r2', [fr('M1', '中', { fix: '无法彻底解决：依赖外部协议，只能降级处理' })]);
  const final = commit(e, 'fix', () => write(e.root, RISK, regFile([regRow('M1', r2.head, 2)])));
  assert.ok(final);
  const r = reg(e, 'code', 'pass', PASS_TEXT);
  assert.equal(r.ok, false);
  assert.match(r.message, /向用户汇报/);
  assert.match(r.message, /专项/);
  assert.equal(close(e, r2.code.path).ok, false, '有无法彻底解决的发现时不能 close');
  assert.equal(fs.existsSync(closeJson(e)), false);
});

// ---------- A9 最后一轮后只剩中、低级 ----------

test('A9 最后一轮只剩中级：新内容上被拒并指向 close；修完写风险登记后 close 成功，closedRound 为 3，合并放行', () => {
  const e = env();
  round(e, 'r1', [fr('H1', '高')]);
  round(e, 'r2', [fr('H2', '高')]);
  const r3 = round(e, 'r3', [fr('M1', '中'), fr('L1', '低')]);
  commit(e, 'probe');
  const blocked = reg(e, 'code', 'pass', PASS_TEXT);
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /review\.mjs close/);
  finish(e, [regRow('M1', r3.head, 3)], 'fix');
  const res = close(e, r3.code.path);
  assert.equal(res.ok, true, res.message);
  assert.equal(JSON.parse(fs.readFileSync(closeJson(e), 'utf8')).closedRound, 3);
  const merge = mergePr({ root: e.root, pr: '7', gh: e.gh });
  assert.equal(merge.ok, true, JSON.stringify(merge.problems));
  assert.match(merge.notes.join('\n'), /收口/);
});

// ---------- A11 默认关闭 ----------

test('A11 收口关闭（默认）：满上限后新内容 pass、fail 要 --user-decision，文案是旧版的，不提 close 与最后一轮；close 命令拒绝并说明未开启；merge 不认 close.json', () => {
  const e = env({ roundClosure: 'off' });
  round(e, 'r1', [fr('H1', '高')]);
  const second = round(e, 'r2', [fr('H2', '高'), fr('M1', '中')]);
  assert.doesNotMatch(second.code.message, /最后一轮|--final-round|close/, '关闭时登记输出不提示最后一轮');
  commit(e, 'r3');
  const blocked = reg(e, 'code', 'pass', PASS_TEXT);
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /已审二轮仍需再审/);
  assert.match(blocked.message, /--user-decision/);
  assert.doesNotMatch(blocked.message, /review\.mjs close|最后一轮/);
  const closed = close(e, second.code.path);
  assert.equal(closed.ok, false);
  assert.match(closed.message, /未开启/);
  // 手工放进一份 close.json（模拟旧记录或伪造）：关闭时 merge 不读它
  const finalHead = commit(e, 'fix');
  fs.mkdirSync(path.dirname(closeJson(e)), { recursive: true });
  fs.writeFileSync(closeJson(e), JSON.stringify({ pr: '7', kind: 'close', verdict: 'close', headSha: finalHead, failHead: second.head, closedRound: 2, at: new Date().toISOString() }));
  const res = mergePr({ root: e.root, pr: '7', gh: e.gh });
  assert.equal(res.ok, false);
  assert.equal(merged(e.gh), false);
  // 带 --user-decision 的旧路径照常
  assert.equal(reg(e, 'code', 'pass', PASS_TEXT, { userDecision: '用户同意再审（对话 2026-11-26）' }).ok, true);
});

// ---------- A12 close 的前提 ----------

/** 两轮后的局面 + 正确的风险登记，供各条件单独破坏。 */
function ready() {
  const e = env();
  const { r2 } = twoRounds(e);
  return { e, r2, rows: [regRow('M1', r2.head, 2), regRow('M2', r2.head, 2)] };
}
/** 断言 close 被拒、没写 close.json，返回拒绝信息。 */
function refused(e, reportPath) {
  const res = close(e, reportPath);
  assert.equal(res.ok, false, '应拒绝：' + res.message);
  assert.equal(fs.existsSync(closeJson(e)), false, '拒绝时不写 close.json');
  return res.message;
}

test('A12 轮次不足：只登记过 1 轮 fail 时不能 close', () => {
  const e = env();
  const r1 = round(e, 'r1', [fr('M1', '中')]);
  finish(e, [regRow('M1', r1.head, 1)]);
  assert.match(refused(e, r1.code.path), /轮次/);
});

test('A12 最新一轮有高级：不能 close，应走最后一轮', () => {
  const e = env();
  round(e, 'r1', [fr('H1', '高')]);
  const r2 = round(e, 'r2', [fr('H2', '高'), fr('M1', '中')]);
  finish(e, [regRow('M1', r2.head, 2)]);
  assert.match(refused(e, r2.code.path), /高级/);
});

test('A12 --report 不是登记过的报告（sha256 对不上任何一条最新一轮的 fail 记录）：拒绝', () => {
  const { e, rows } = ready();
  finish(e, rows);
  // 正文要与已登记的报告不同（M1 的问题描述换了），否则 sha256 相同，按计划本就应当接受
  const neverRegistered = reportFile(failText([fr('M1', '中', { problem: '去重后顺序与输入不一致（未登记的另一份报告）' }), fr('L1', '低')]));
  assert.match(refused(e, neverRegistered), /最新一轮/);
});

test('A12 --report 是第 1 轮的报告（登记过，但不是最新一轮）：拒绝', () => {
  const e = env();
  const r1 = round(e, 'r1', [fr('H1', '高'), fr('M1', '中')]);
  const r2 = round(e, 'r2', [fr('M1', '中')], [fr('M2', '中')]);
  finish(e, [regRow('M1', r2.head, 2), regRow('M2', r2.head, 2)]);
  assert.match(refused(e, r1.code.path), /最新一轮/);
});

test('A12 最终提交等于最新一轮的被审提交（修完之后没有新提交）：拒绝', () => {
  const e = env();
  const { r2 } = twoRounds(e);
  assert.equal(e.st.head, r2.head);
  assert.match(refused(e, r2.code.path), /最终提交.*(相同|等于|没有新|没有修复)|(相同|等于|没有新|没有修复).*最终提交/);
});

test('A12 风险登记：文件缺失、缺某个中级编号、状态不是“已修、未再复审”，都拒绝并指出', () => {
  // 文件没有提交
  const a = ready();
  finish(a.e, null);
  assert.match(refused(a.e, a.r2.code.path), /风险登记/);
  // 缺 M2
  const b = ready();
  finish(b.e, [b.rows[0]]);
  assert.match(refused(b.e, b.r2.code.path), /M2/);
  // M1 的状态不对
  const c = ready();
  finish(c.e, [regRow('M1', c.r2.head, 2, { status: '待修' }), c.rows[1]]);
  assert.match(refused(c.e, c.r2.code.path), /M1/);
  // 提交前缀短于 7 位
  const d = ready();
  finish(d.e, [regRow('M1', d.r2.head, 2, { len: 6 }), d.rows[1]]);
  assert.match(refused(d.e, d.r2.code.path), /M1/);
  // 登记的是别的 PR
  const f = ready();
  finish(f.e, [regRow('M1', f.r2.head, 2, { pr: '#8' }), f.rows[1]]);
  assert.match(refused(f.e, f.r2.code.path), /M1/);
});

test('A12 同一编号出现在最新一轮的两份报告里：风险登记要两行，只写一行拒绝', () => {
  const e = env();
  round(e, 'r1', [fr('H1', '高')]);
  const r2 = round(e, 'r2', [fr('M1', '中')], [fr('M1', '中')]);
  finish(e, [regRow('M1', r2.head, 2)]);
  assert.match(refused(e, r2.code.path), /M1/);
  finish(e, [regRow('M1', r2.head, 2), regRow('M1', r2.head, 2)], 'fix2');
  assert.equal(close(e, r2.code.path).ok, true);
});

test('A12 PR 未打开、CI 未过：拒绝', () => {
  const a = ready();
  finish(a.e, a.rows);
  a.e.st.state = 'CLOSED';
  assert.match(refused(a.e, a.r2.code.path), /打开/);
  const b = ready();
  finish(b.e, b.rows);
  b.e.st.conclusion = 'FAILURE';
  assert.match(refused(b.e, b.r2.code.path), /CI/);
});

test('A12 前提不满足时逐条列出，不在第一条就停：一次同时触发轮次不足、风险登记缺失、PR 未打开、CI 未过', () => {
  const e = env();
  const r1 = round(e, 'r1', [fr('M1', '中')]);
  commit(e, 'fix'); // 有新提交，但没有风险登记
  e.st.state = 'CLOSED';
  e.st.conclusion = 'FAILURE';
  const msg = refused(e, r1.code.path);
  assert.match(msg, /轮次/);
  assert.match(msg, /风险登记/);
  assert.match(msg, /打开/);
  assert.match(msg, /CI/);
});

// ---------- 首轮复审的修复（PR #40）：收口前提与最后一轮 ----------

test('收口前提：最新一轮另一种审查还没登记时不能 close；补登之后可以（迟到的第二份意见）', () => {
  const e = env();
  round(e, 'r1', [fr('H1', '高')]);
  const head2 = commit(e, 'r2');
  const code = reg(e, 'code', 'fail', failText([fr('M1', '中')]));
  assert.equal(code.ok, true, code.message);
  finish(e, [regRow('M1', head2, 2)]);
  const msg = refused(e, code.path);
  assert.match(msg, /一致性审/);
  assert.match(msg, /收齐/);
  // 一致性审补登在第 2 轮的内容上（并行例外放行），之后 close 成功
  const fixHead = e.st.head;
  e.st.head = head2;
  assert.equal(reg(e, 'consistency', 'pass', PASS_TEXT).ok, true);
  e.st.head = fixHead;
  assert.equal(close(e, code.path).ok, true);
});

test('收口前提：修复要有改动证据——只改风险登记、或中级问题所在的文件没改，都不能 close', () => {
  const a = ready();
  write(a.e.root, RISK, regFile(a.rows));
  commitAll(a.e.root, 'only-register');
  a.e.st.head = git(a.e.root, ['rev-parse', 'HEAD']).trim();
  assert.match(refused(a.e, a.r2.code.path), /只改了风险登记/);
  // 改了别的文件，但问题所在的 src/dedup.ts 没动
  const b = ready();
  write(b.e.root, RISK, regFile(b.rows));
  write(b.e.root, 'src/other.ts', `${SRC_HEADER}export const other = 1;\n`);
  commitAll(b.e.root, 'unrelated');
  b.e.st.head = git(b.e.root, ['rev-parse', 'HEAD']).trim();
  assert.match(refused(b.e, b.r2.code.path), /src\/dedup\.ts.*没有改动/);
});

test('收口前提：最终提交不是最新一轮被审提交的后代时拒绝', () => {
  const e = env();
  const r1 = round(e, 'r1', [fr('H1', '高')]);
  const r2 = round(e, 'r2', [fr('M1', '中')]);
  git(e.root, ['checkout', '-q', r1.head]);
  finish(e, [regRow('M1', r2.head, 2)]);
  assert.match(refused(e, r2.code.path), /祖先/);
});

test('风险登记逐条对应：两份报告用了同一编号、指的是不同问题时，抄两遍同一行不算；各写自己的位置和问题才放行', () => {
  const e = env();
  round(e, 'r1', [fr('H1', '高')]);
  const r2 = round(e, 'r2', [fr('M1', '中')], [fr('M1', '中', { problem: '文档里的默认值与代码不一致' })]);
  finish(e, [regRow('M1', r2.head, 2), regRow('M1', r2.head, 2)]);
  assert.match(refused(e, r2.code.path), /M1.*位置、问题须照报告填写/);
  const other = regRow('M1', r2.head, 2).replace('去重丢顺序', '文档里的默认值与代码不一致');
  finish(e, [regRow('M1', r2.head, 2), other], 'fix2');
  const res = close(e, r2.code.path);
  assert.equal(res.ok, true, res.message);
});

test('最后一轮只开放一份内容：第 N+1 轮双审通过后，换到别的提交再登记要 --user-decision', () => {
  const e = env();
  round(e, 'r1', [fr('H1', '高')]);
  round(e, 'r2', [fr('H2', '高')]);
  commit(e, 'r3');
  assert.equal(reg(e, 'code', 'pass', PASS_TEXT).ok, true, '最后一轮第一份');
  assert.equal(reg(e, 'consistency', 'pass', PASS_TEXT).ok, true, '同一内容上的另一种审查照常');
  commit(e, 'r4');
  for (const verdict of ['pass', 'fail']) {
    const r = reg(e, 'code', verdict, verdict === 'pass' ? PASS_TEXT : failText([fr('M1', '中')]));
    assert.equal(r.ok, false, verdict);
    assert.match(r.message, /最后一轮已用在提交/);
    assert.match(r.message, /--user-decision/);
  }
  assert.equal(reg(e, 'code', 'pass', PASS_TEXT, { userDecision: '用户同意再审（对话 2026-11-26）' }).ok, true);
});

test('合并入口：收口后只改文档且风险登记仍有效时沿用收口；改坏风险登记时拒绝，之后对最终提交重新双审通过可按普通双审放行', () => {
  const e = env();
  const { r2 } = twoRounds(e);
  finish(e, [regRow('M1', r2.head, 2), regRow('M2', r2.head, 2)]);
  assert.equal(close(e, r2.code.path).ok, true);
  // 只改文档（README），风险登记不变：沿用收口
  write(e.root, 'docs/notes.md', '# 说明\n\n状态：active\n\n补一句说明。\n');
  commitAll(e.root, 'docs');
  e.st.head = git(e.root, ['rev-parse', 'HEAD']).trim();
  const kept = mergePr({ root: e.root, pr: '7', gh: e.gh });
  assert.equal(kept.ok, true, JSON.stringify(kept.problems));
  assert.match(kept.notes.join('\n'), /收口/);
  // 另一个环境：改坏风险登记（删掉 M2 一行）
  const b = env();
  const { r2: s2 } = twoRounds(b);
  finish(b, [regRow('M1', s2.head, 2), regRow('M2', s2.head, 2)]);
  assert.equal(close(b, s2.code.path).ok, true);
  write(b.root, RISK, regFile([regRow('M1', s2.head, 2)]));
  commitAll(b.root, 'break-register');
  b.st.head = git(b.root, ['rev-parse', 'HEAD']).trim();
  const broken = mergePr({ root: b.root, pr: '7', gh: b.gh });
  assert.equal(broken.ok, false);
  assert.match(broken.problems.join('\n'), /收口：.*M2/);
  // 用户决定对最终提交重新双审，两项都通过：普通双审接管，旧收口不再挡路
  const ud = { userDecision: '用户决定重新复审最终提交（对话 2026-11-26）' };
  assert.equal(reg(b, 'code', 'pass', PASS_TEXT, ud).ok, true);
  assert.equal(reg(b, 'consistency', 'pass', PASS_TEXT, ud).ok, true);
  const normal = mergePr({ root: b.root, pr: '7', gh: b.gh });
  assert.equal(normal.ok, true, JSON.stringify(normal.problems));
  assert.match(normal.notes.join('\n'), /收口记录不再有效/);
});

test('发现节改了名（reviewSections 里叫“审查发现”）时，发现表在那一节里照样认，fail 能登记', () => {
  const e = env({ reviewSections: ['范围', '审查发现', '作者的验证'] });
  commit(e, 'r1');
  const text = failText([fr('M1', '中')]).replace('## 发现', '## 审查发现');
  const r = reg(e, 'code', 'fail', text);
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(r.record.findings.mediumIds, ['M1']);
});
