// 复审报告解析测试（gate/report.mjs）：发现表的解析、缺项判定、围栏处理，以及从 review.mjs 迁入的函数不回归。
// 业务含义：高、中级发现必须写清理由和建议改法（契约 A2、A3），闸门要能从报告文本里可靠地读出发现表；
// 报告是模型或人写的文本，列序、写法、围栏里的示例表都不能骗过解析。对应计划 plan-pr1.md“报告与发现表”一节。
// 约定的接口（计划里只定了函数名，返回字段按下面的假定写，见测试交回说明）：
//   parseFindings(text) → { parsed, high, medium, low, info, unresolvable, highIds, mediumIds, rows }；没有可解析的表时 parsed 为 0。
//   rows 的每项：{ id, mark, severity, location, problem, trigger, reason, fix }，severity 为 high|medium|low|info。
//   findingGaps(row) → 缺的栏名数组（中文：理由、建议改法）；findingProblems(text) → 拒绝原因数组，空数组表示合格。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FINDING_COLUMNS,
  findingGaps,
  findingProblems,
  findingsSection,
  hiddenProblems,
  markFences,
  missingSections,
  parseFindings,
  reportVerdict,
  UNRESOLVABLE,
} from '../gate/report.mjs';
import * as review from '../gate/review.mjs';

const HEAD7 = '| 编号 | 级别 | 位置 | 问题 | 触发条件或例子 | 理由 | 建议改法 |\n|---|---|---|---|---|---|---|';
const row = (...cells) => `| ${cells.join(' | ')} |`;
/** 一行合格的发现（七栏齐全）。 */
const ok = (id, sev, over = {}) => row(id, sev, 'src/dedup.ts:3', over.problem ?? '去重丢顺序', '输入含重复项', over.reason ?? '改变调用方看到的顺序，影响展示', over.fix ?? '改用保序去重');
/** 带发现表的报告。 */
const doc = (...tableLines) => `## 范围\n读了 dedup 函数与测试。\n\n## 发现\n\n${HEAD7}\n${tableLines.join('\n')}\n\n## 作者的验证\n核对了测试输出。\n\n## 结论\n不通过。H1 未修复。\n`;

test('A2 常量：发现表七栏按约定的顺序，“无法彻底解决”是固定写法', () => {
  assert.deepEqual(FINDING_COLUMNS, ['编号', '级别', '位置', '问题', '触发条件或例子', '理由', '建议改法']);
  assert.equal(UNRESOLVABLE, '无法彻底解决');
});

test('A2 解析：七栏表按级别计数，登记用的编号清单只含高、中级', () => {
  const f = parseFindings(doc(ok('H1', '高'), ok('M1', '中'), ok('M2', '中级'), ok('L1', '低'), ok('I1', '提示')));
  assert.equal(f.parsed, 5);
  assert.equal(f.high, 1);
  assert.equal(f.medium, 2);
  assert.equal(f.low, 1);
  assert.equal(f.info, 1);
  assert.equal(f.unresolvable, 0);
  assert.deepEqual(f.highIds, ['H1']);
  assert.deepEqual(f.mediumIds, ['M1', 'M2']);
  assert.deepEqual(f.rows.map((r) => r.severity), ['high', 'medium', 'medium', 'low', 'info']);
});

test('A2 解析：按表头列名匹配，不依赖列序；“推荐措施”是“建议改法”的别名', () => {
  const text = `## 发现\n\n| 理由 | 推荐措施 | 编号 | 级别 | 问题 | 位置 | 触发条件或例子 |\n|---|---|---|---|---|---|---|\n| 影响大 | 改用保序 | M1 | 中 | 丢顺序 | a.ts:1 | 重复项 |\n\n## 结论\n不通过。\n`;
  const f = parseFindings(text);
  assert.equal(f.parsed, 1);
  assert.equal(f.medium, 1);
  assert.deepEqual(f.mediumIds, ['M1']);
  assert.equal(f.rows[0].reason, '影响大');
  assert.equal(f.rows[0].fix, '改用保序');
  assert.deepEqual(findingGaps(f.rows[0]), []);
  assert.deepEqual(findingProblems(text), []);
});

test('A2 级别归一：高/高级/H/high、中/中级/M/medium、低/低级/L/low、提示/info；其他写法是不可识别行', () => {
  const sev = (s) => parseFindings(doc(ok('X1', s))).rows?.[0]?.severity;
  for (const s of ['高', '高级', 'H', 'high', 'High']) assert.equal(sev(s), 'high', s);
  for (const s of ['中', '中级', 'M', 'medium']) assert.equal(sev(s), 'medium', s);
  for (const s of ['低', '低级', 'L', 'low']) assert.equal(sev(s), 'low', s);
  for (const s of ['提示', 'info']) assert.equal(sev(s), 'info', s);
  const mixed = doc(ok('H1', '高'), ok('Z1', '严重'));
  assert.equal(parseFindings(mixed).high, 1);
  assert.ok(findingProblems(mixed).some((p) => /Z1|严重|不可识别|无法识别/.test(p)), '不可识别的级别写法要报出来');
});

test('A3 空栏写法：高、中级行的理由或建议改法为空（含 无、暂无、待补、-、—、/、n/a、tbd 与纯修饰）都算缺', () => {
  for (const empty of ['', ' ', '无', '暂无', '待补', '-', '—', '/', 'n/a', 'N/A', 'tbd', 'TBD', '**无**', '`待补`', '*—*']) {
    for (const col of ['reason', 'fix']) {
      const over = { [col]: empty };
      const r = parseFindings(doc(ok('H1', '高', over))).rows[0];
      assert.deepEqual(findingGaps(r), [col === 'reason' ? '理由' : '建议改法'], `${col}=${JSON.stringify(empty)}`);
    }
  }
  const both = parseFindings(doc(ok('M1', '中', { reason: '无', fix: '待补' }))).rows[0];
  assert.deepEqual(findingGaps(both), ['理由', '建议改法']);
  // 低级与提示不要求这两栏
  for (const s of ['低', '提示']) {
    const r = parseFindings(doc(ok('L1', s, { reason: '', fix: '' }))).rows[0];
    assert.deepEqual(findingGaps(r), [], `${s}不要求理由和建议改法`);
  }
});

test('A3 问题清单：合格的表没有问题；没有发现表、缺表头栏、行里缺栏都有对应的问题，并写明第几行和编号', () => {
  assert.deepEqual(findingProblems(doc(ok('H1', '高'), ok('M1', '中'))), []);
  assert.ok(findingProblems('## 发现\n无高、中级问题。\n\n## 结论\n不通过。\n').length > 0, '没有发现表');
  const noReasonCol = `## 发现\n\n| 编号 | 级别 | 位置 | 问题 | 触发条件或例子 | 建议改法 |\n|---|---|---|---|---|---|\n| H1 | 高 | a | b | c | d |\n\n## 结论\n不通过。\n`;
  assert.match(findingProblems(noReasonCol).join('\n'), /理由/);
  const noFixCol = `## 发现\n\n| 编号 | 级别 | 位置 | 问题 | 触发条件或例子 | 理由 |\n|---|---|---|---|---|---|\n| H1 | 高 | a | b | c | d |\n\n## 结论\n不通过。\n`;
  assert.match(findingProblems(noFixCol).join('\n'), /建议改法|推荐措施/);
  // 第 2 个数据行（编号 M1）两栏都缺；第 1 行合格
  const bad = doc(ok('H1', '高'), ok('M1', '中', { reason: '', fix: '无' }));
  const problems = findingProblems(bad);
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /第 2 行.{0,3}M1.{0,3}缺.*理由.*建议改法/);
});

test('A2 标记与特殊内容：编号后的既有、修复新增、原先漏检、重复出现不进编号；单元格里转义的竖线不拆列', () => {
  const f = parseFindings(doc(
    ok('H1 既有', '高'),
    ok('M2 修复新增', '中'),
    ok('M3 原先漏检', '中'),
    ok('M4 重复出现', '中'),
    row('M5', '中', 'a.ts:1', '条件 a \\| b 写反', '输入含竖线', '会误判', '改为校验'),
  ));
  assert.deepEqual(f.highIds, ['H1']);
  assert.deepEqual(f.mediumIds, ['M2', 'M3', 'M4', 'M5']);
  assert.equal(f.parsed, 5);
  assert.equal(f.rows[4].fix, '改为校验', '转义的竖线不应把后面的栏挤歪');
  assert.match(f.rows[4].problem, /a\s*\\?\|\s*b/);
});

test('A2 围栏：代码围栏里的表不算发现表', () => {
  const fenced = `## 范围\nx\n\n## 发现\n\n示例格式：\n\n\`\`\`markdown\n${HEAD7}\n${ok('H1', '高')}\n\`\`\`\n\n## 结论\n不通过。\n`;
  assert.equal(parseFindings(fenced).parsed, 0);
  assert.ok(findingProblems(fenced).length > 0, '围栏里的表不算有发现表');
});

test('A8 无法彻底解决：建议改法以“无法彻底解决”开头才计入 unresolvable，句中出现不算；该栏非空，不算缺项', () => {
  const f = parseFindings(doc(
    ok('H1', '高', { fix: '无法彻底解决：依赖外部协议，只能降级' }),
    ok('M1', '中', { fix: '这个问题无法彻底解决，但可缓解' }),
    ok('M2', '中'),
  ));
  assert.equal(f.unresolvable, 1);
  assert.deepEqual(findingProblems(doc(ok('H1', '高', { fix: '无法彻底解决：依赖外部协议' }))), []);
});

test('迁移不回归：review.mjs 仍导出 markFences、reportVerdict、missingSections、ROUND_KEYS，且与新模块是同一个函数', () => {
  assert.equal(review.markFences, markFences);
  assert.equal(review.reportVerdict, reportVerdict);
  assert.equal(review.missingSections, missingSections);
  assert.equal(typeof review.ROUND_KEYS?.pr?.of, 'function');
  assert.equal(typeof review.ROUND_KEYS?.['pre-push']?.of, 'function');
  assert.equal(reportVerdict('## 结论\n不通过。H1 未修复。\n').verdict, 'fail');
  assert.equal(reportVerdict('## 结论\n通过。\n').verdict, 'pass');
  assert.deepEqual(missingSections('## 范围\nx\n## 发现\ny\n', ['范围', '发现', '作者的验证']), ['作者的验证']);
  assert.equal(markFences('a\n```\nb\n```\nc').lines.length, 5);
});

// ---------- 首轮复审的修复（PR #40） ----------

test('高、中级行还要写位置、问题、触发条件；低级不要求', () => {
  assert.deepEqual(findingGaps({ severity: 'medium', location: '', problem: 'p', trigger: '', reason: 'r', fix: 'f' }), ['位置', '触发条件或例子']);
  assert.deepEqual(findingGaps({ severity: 'high', location: 'a.ts', problem: '-', trigger: 't', reason: 'r', fix: 'f' }), ['问题']);
  assert.deepEqual(findingGaps({ severity: 'low', location: '', problem: '', trigger: '', reason: '', fix: '' }), []);
  assert.match(findingProblems(doc(row('M1', '中', '', '问题', '', '理由', '改法'))).join('\n'), /M1.*缺.*位置.*触发条件或例子/);
});

test('发现节的节名可配置：findingsSection 取 reviewSections 里含“发现”的节名；找不到表时提示写明节名', () => {
  assert.equal(findingsSection(['范围', '发现', '作者的验证']), '发现');
  assert.equal(findingsSection(['范围', '审查发现', '作者的验证']), '审查发现');
  assert.equal(findingsSection(['范围', '作者的验证']), '发现');
  const renamed = doc(ok('M1', '中')).replace('## 发现', '## 审查发现');
  assert.equal(parseFindings(renamed, { section: '审查发现' }).parsed, 1);
  assert.match(findingProblems(renamed).join('\n'), /“发现”一节里找不到可解析的表头/);
});

// ---------- 严格格式（PR #40 第三轮复审后，用户决定：看不懂的写法一律拒绝，不去猜） ----------

test('HTML 注释：围栏之外出现 <!-- 就报出行号（行内代码里的也算）；围栏里的不算', () => {
  assert.deepEqual(hiddenProblems(doc(ok('M1', '中'))), []);
  const comment = `## 发现\n\n<!--\n${HEAD7}\n${ok('H1', '高')}\n-->\n\n## 结论\n不通过。\n`;
  assert.match(hiddenProblems(comment).join('\n'), /第 3 行有 HTML 注释/);
  assert.equal(hiddenProblems('结论：通过 `<!--` 写法').length, 1, '行内代码里的也拒绝，要提到这个符号请用文字描述');
  assert.equal(hiddenProblems('## 作者的验证\n\n```html\n<!-- 测试输出里的注释 -->\n```\n').length, 0, '围栏里的测试输出不算');
});

test('发现节严格读取：含竖线却不是合格表格行的行、缩进四格的表、节里的代码块、附带的其他表，都报出行号', () => {
  const noPipes = doc(ok('M1', '中')).replace(ok('M1', '中'), `${ok('M1', '中')}\n H1 | 高 | b.ts | p | t | r | f `);
  assert.match(findingProblems(noPipes).join('\n'), /像表格行但不合格式/, '少了首尾竖线的行不能悄悄丢掉');
  const indented = `## 发现\n\n${HEAD7.split('\n').map((l) => '    ' + l).join('\n')}\n    ${ok('H1', '高')}\n\n## 结论\n不通过。\n`;
  const p = findingProblems(indented).join('\n');
  assert.match(p, /像表格行但不合格式/, '缩进四格是代码块，不当表');
  assert.equal(parseFindings(indented).parsed, 0);
  const fenced = `## 发现\n\n${HEAD7}\n${ok('M1', '中')}\n\n\`\`\`\n${ok('H1', '高')}\n\`\`\`\n\n## 结论\n不通过。\n`;
  assert.match(findingProblems(fenced).join('\n'), /有代码块/);
  const aux = doc(ok('M1', '中')).replace('## 作者的验证', '| 位置 | 证据 |\n|---|---|\n| src/dedup.ts | 复现输出 |\n\n## 作者的验证');
  assert.match(findingProblems(aux).join('\n'), /表头缺/, '发现节只放七栏发现表');
  assert.deepEqual(findingProblems(doc(ok('M1', '中'), ok('L1', '低'))), [], '合格的表没有问题');
});

test('pass 用的宽松读法：发现写“无”没有问题；写了表就要合格（requireTable 为假时不要求有表）', () => {
  const none = '## 范围\nx\n\n## 发现\n无高、中级问题。\n\n## 结论\n通过。\n';
  assert.deepEqual(findingProblems(none, { requireTable: false }), []);
  assert.ok(findingProblems(none).length > 0, 'fail 与 accept 要有表');
  const broken = none.replace('无高、中级问题。', `${HEAD7}\n| L1 | 低 | a.ts | 命名 |`);
  assert.match(findingProblems(broken, { requireTable: false }).join('\n'), /列数与表头不符/);
});

test('同一行写法的发现节遇到项目配置的其他节名就结束，后面那一节里的表不算发现表；节名不分大小写', () => {
  const inline = `范围：读了 dedup。\n发现：见下表。\n${HEAD7}\n${ok('M1', '中')}\n验证摘要：贴了输出\n${HEAD7}\n${ok('H1', '高')}\n结论：不通过。\n`;
  const f = parseFindings(inline, { sections: ['范围', '发现', '验证摘要'] });
  assert.deepEqual(f.mediumIds, ['M1']);
  assert.deepEqual(f.highIds, [], '验证摘要一节里的表不归发现节');
  const upper = doc(ok('M1', '中')).replace('## 发现', '## API 发现');
  assert.equal(parseFindings(upper, { section: 'api 发现' }).parsed, 1);
});
