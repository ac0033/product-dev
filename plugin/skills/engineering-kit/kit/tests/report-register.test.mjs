// 复审登记的发现表检查（契约 A3）：featureRepo 配成 pr 流程，用假 gh 和真实提交，走 review.mjs 的 recordReview。
// 业务含义：不通过（fail）和接受风险（accept）的报告必须带七栏发现表，高、中级每条写清位置、问题、触发条件、理由和建议改法；
// 至少要有一条高、中级（只有低级或提示时结论应为通过）；登记记录带上轮次、报告指纹和发现统计。发现节的节名随 reviewSections。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { recordReview } from '../gate/review.mjs';
import { commitAll, featureRepo, git, read, reportFile, SRC_HEADER, write } from './helpers.mjs';

const PASS_TEXT = '## 范围\n读了 dedup 函数、调用方和测试。\n\n## 发现\n无高、中级问题。\n\n## 作者的验证\n核对了作者给出的测试输出，没有重跑。\n\n## 结论\n通过。无高、中级问题。\n';
const HEAD7 = '| 编号 | 级别 | 位置 | 问题 | 触发条件或例子 | 理由 | 建议改法 |\n|---|---|---|---|---|---|---|';
/** 一行发现；over 里可覆盖理由、建议改法。 */
const fr = (id, sev, over = {}) => `| ${id} | ${sev} | src/dedup.ts:3 | ${over.problem ?? '去重丢顺序'} | 输入含重复项 | ${over.reason ?? '改变调用方看到的顺序，影响展示'} | ${over.fix ?? '改用保序去重'} |`;
/** 带发现表的 fail 报告。 */
const failText = (rows) => `## 范围\n读了 dedup 函数、调用方和测试。\n\n## 发现\n\n${HEAD7}\n${rows.join('\n')}\n\n## 作者的验证\n核对了作者给出的测试输出，没有重跑。\n\n## 结论\n不通过。H1 未修复。\n`;
/** 没有发现表、只用文字写发现的 fail 报告。 */
const NO_TABLE = '## 范围\n读了 dedup 函数、调用方和对应的测试文件。\n\n## 发现\nH1 未修复：删除接口越权，这里没有写成表。\n\n## 作者的验证\n核对了作者给出的测试输出，没有重跑。\n\n## 结论\n不通过。H1 未修复。\n';
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file, 'utf8')).digest('hex');

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
/** pr 流程（上限 2）的环境；config 可覆盖。 */
function env(config = {}) {
  const root = featureRepo({ reviewFlow: 'pr', maxReviewRounds: 2, ...config });
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

/** 登记一份审查；报告文件路径挂在返回值的 path 上。 */
function reg(e, kind, verdict, text, extra = {}) {
  const reportPath = extra.reportPath ?? reportFile(text);
  const res = recordReview({ root: e.root, verdict, pr: '7', kind, gh: e.gh, reviewer: 'general-purpose', reportPath, summary: 's', ...extra });
  return Object.assign(res, { path: reportPath });
}

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

test('发现节改了名（reviewSections 里叫“审查发现”）时，发现表在那一节里照样认，fail 能登记', () => {
  const e = env({ reviewSections: ['范围', '审查发现', '作者的验证'] });
  commit(e, 'r1');
  const text = failText([fr('M1', '中')]).replace('## 发现', '## 审查发现');
  const r = reg(e, 'code', 'fail', text);
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(r.record.findings.mediumIds, ['M1']);
});

test('只有低级或提示的报告不能登记为 fail 或 accept（与外部复审同一规则）', () => {
  const e = env();
  commit(e, 'r1');
  for (const verdict of ['fail', 'accept']) {
    const r = reg(e, 'code', verdict, failText([fr('L1', '低', { reason: '', fix: '' })]), verdict === 'accept' ? { userDecision: '用户接受（对话 2026-11-26）' } : {});
    assert.equal(r.ok, false, verdict);
    assert.match(r.message, /没有高、中级问题/, verdict);
  }
});

test('报告里有 HTML 注释（读者看不见）时任何结论都不登记：注释里的结论、必需节、发现都不算', () => {
  const e = env();
  commit(e, 'r1');
  const hiddenVerdict = '## 范围\n读了 dedup 函数、调用方和测试。\n\n## 发现\n无高、中级问题。\n\n## 作者的验证\n核对了测试输出。\n\n<!--\n## 结论\n通过。\n-->\n';
  const r = reg(e, 'code', 'pass', hiddenVerdict);
  assert.equal(r.ok, false);
  assert.match(r.message, /HTML 注释/);
  const hiddenRow = failText([fr('M1', '中')]).replace('## 作者的验证', '<!-- | H1 | 高 | src/a.ts | 越权 | x | y | z | -->\n\n## 作者的验证');
  const f = reg(e, 'code', 'fail', hiddenRow);
  assert.equal(f.ok, false);
  assert.match(f.message, /HTML 注释/);
});

test('结论与发现要一致：pass 报告的发现表里有高、中级问题时拒绝；只有低级时 pass 照常', () => {
  const e = env();
  commit(e, 'r1');
  const passWithMedium = failText([fr('M1', '中')]).replace('不通过。H1 未修复。', '通过。');
  const r = reg(e, 'code', 'pass', passWithMedium);
  assert.equal(r.ok, false);
  assert.match(r.message, /结论是通过，但发现表里有 1 个高、中级问题/);
  const passWithLow = failText([fr('L1', '低', { reason: '', fix: '' })]).replace('不通过。H1 未修复。', '通过。只有一条命名建议。');
  const ok = reg(e, 'code', 'pass', passWithLow);
  assert.equal(ok.ok, true, ok.message);
});

test('发现表格式看不懂就拒绝登记：少了首尾竖线的发现行不能被悄悄丢掉', () => {
  const e = env();
  commit(e, 'r1');
  const text = failText([fr('M1', '中')]).replace(fr('M1', '中'), `${fr('M1', '中')}\n H1 | 高 | src/a.ts | 越权 | x | y | z `);
  const r = reg(e, 'code', 'fail', text);
  assert.equal(r.ok, false);
  assert.match(r.message, /像表格行但不合格式/);
});
