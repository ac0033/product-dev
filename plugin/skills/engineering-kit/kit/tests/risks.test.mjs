// 风险登记解析与核对测试（gate/risks.mjs，纯函数）：十栏表、逐个中级编号一一对应、同一编号出现在两份报告里要两行、
// 提交前缀不少于 7 位、轮次、状态前缀、空栏、PR 的两种写法。对应契约 A6、A12 与计划“风险登记表栏目”一段。
// 约定的接口（见交回说明）：
//   parseRegister(text) → { rows }，rows 每项 { id, pr, commit, round, severity, location, problem, reason, fix, status }（均为字符串，round 也按文本）。
//   registerProblems(text, { pr, failHead, round, mediumIds }) → 问题数组，空数组表示合格；mediumIds 是最新一轮各 fail 报告的中级编号，同一编号在两份报告里出现就写两次。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FIXED_STATUS, parseRegister, REGISTER_COLUMNS, registerProblems } from '../gate/risks.mjs';

const FAIL_HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const HEADER = `| ${['编号', 'PR', '提交', '轮次', '级别', '位置', '问题', '理由', '推荐措施', '状态'].join(' | ')} |\n|${'---|'.repeat(10)}`;
const ROW = { id: 'M1', pr: '#12', commit: FAIL_HEAD.slice(0, 12), round: '2', sev: '中', loc: 'src/a.ts:3', problem: '去重丢顺序', reason: '影响展示顺序', fix: '改用保序去重', status: '已修、未再复审' };
const row = (o = {}) => {
  const r = { ...ROW, ...o };
  return `| ${[r.id, r.pr, r.commit, r.round, r.sev, r.loc, r.problem, r.reason, r.fix, r.status].join(' | ')} |`;
};
const register = (...rows) => `# 风险登记\n\n${HEADER}\n${rows.join('\n')}\n`;
const CTX = { pr: '12', failHead: FAIL_HEAD, round: 2, mediumIds: ['M1'] };
const problems = (text, over = {}) => registerProblems(text, { ...CTX, ...over });

test('A12 常量：十栏按约定顺序，固定状态前缀是“已修、未再复审”', () => {
  assert.deepEqual(REGISTER_COLUMNS, ['编号', 'PR', '提交', '轮次', '级别', '位置', '问题', '理由', '推荐措施', '状态']);
  assert.equal(FIXED_STATUS, '已修、未再复审');
});

test('A12 解析：十栏表解析成行，按表头列名匹配', () => {
  const t = register(row(), row({ id: 'M2', round: '3' }));
  const { rows } = parseRegister(t);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'M1');
  assert.equal(rows[1].id, 'M2');
  assert.equal(rows[0].status, '已修、未再复审');
  assert.deepEqual(parseRegister('# 风险登记\n\n没有表\n').rows, []);
});

test('A12 合格：编号、PR、提交前缀、轮次、级别、四栏内容、状态都对时没有问题；PR 写 #12 或 12 都认', () => {
  assert.deepEqual(problems(register(row())), []);
  assert.deepEqual(problems(register(row({ pr: '12' }))), []);
  assert.deepEqual(problems(register(row({ pr: '#12' })), { pr: 12 }), [], 'pr 参数是数字也认');
  // 状态以固定前缀开头即可，后面可以补充说明
  assert.deepEqual(problems(register(row({ status: '已修、未再复审（见提交 abc1234）' }))), []);
  // 登记里还有别的 PR、别的轮次的行，不影响本 PR 的核对
  assert.deepEqual(problems(register(row({ id: 'M7', pr: '#9', round: '1' }), row())), []);
});

test('A12 逐个中级编号对应：缺哪个编号就报哪个；每个编号一行', () => {
  const two = { mediumIds: ['M1', 'M2'] };
  assert.deepEqual(problems(register(row(), row({ id: 'M2' })), two), []);
  const p = problems(register(row()), two);
  assert.ok(p.length >= 1);
  assert.match(p.join('\n'), /M2/);
  assert.doesNotMatch(p.join('\n'), /M1/, '已有的编号不报');
  assert.ok(problems('# 风险登记\n\n无\n').length >= 1, '没有表');
});

test('A12 同一编号出现在两份报告里时要两行', () => {
  const dup = { mediumIds: ['M1', 'M1'] };
  assert.ok(problems(register(row()), dup).length >= 1, '只有一行不够');
  assert.match(problems(register(row()), dup).join('\n'), /M1/);
  assert.deepEqual(problems(register(row(), row()), dup), []);
});

test('A12 提交前缀：至少 7 位且是 failHead 的前缀；短于 7 位、不是前缀、空都不行；写全 40 位可以', () => {
  assert.deepEqual(problems(register(row({ commit: FAIL_HEAD.slice(0, 7) }))), []);
  assert.deepEqual(problems(register(row({ commit: FAIL_HEAD }))), []);
  for (const commit of [FAIL_HEAD.slice(0, 6), 'abcdef1', 'ffffffffffff', '']) {
    const p = problems(register(row({ commit })));
    assert.ok(p.length >= 1, `commit=${JSON.stringify(commit)}`);
    assert.match(p.join('\n'), /M1/);
  }
});

test('A12 轮次、PR、级别、状态：写错一栏，该编号就算没有对应的行', () => {
  const bad = [
    { round: '1' },
    { round: '3' },
    { round: '' },
    { pr: '#13' },
    { pr: '' },
    { sev: '高' },
    { sev: '低' },
    { status: '待修' },
    { status: '已修' },
    { status: '' },
  ];
  for (const over of bad) {
    const p = problems(register(row(over)));
    assert.ok(p.length >= 1, JSON.stringify(over));
    assert.match(p.join('\n'), /M1/, JSON.stringify(over));
  }
});

test('A12 空栏：位置、问题、理由、推荐措施任一为空（含 无、待补、-）该行不合格', () => {
  for (const col of ['loc', 'problem', 'reason', 'fix']) {
    for (const empty of ['', ' ', '无', '待补', '-', '—']) {
      const p = problems(register(row({ [col]: empty })));
      assert.ok(p.length >= 1, `${col}=${JSON.stringify(empty)}`);
      assert.match(p.join('\n'), /M1/);
    }
  }
});

test('A12 表头缺栏：缺“推荐措施”等必需栏时报出来', () => {
  const noFix = `${HEADER.replace(' 推荐措施 |', '').replace('|---|---|---|---|---|---|---|---|---|---|', '|---|---|---|---|---|---|---|---|---|')}\n| M1 | #12 | ${FAIL_HEAD.slice(0, 12)} | 2 | 中 | a | b | c | 已修、未再复审 |\n`;
  const p = registerProblems(noFix, CTX);
  assert.ok(p.length >= 1);
  assert.match(p.join('\n'), /推荐措施/);
});
