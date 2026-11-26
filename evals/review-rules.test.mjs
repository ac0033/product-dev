// 复审规则文档检查（契约 A1、A2、A5、A10 与收口、风险登记模板）：读 plugin/ 下的 review.md 与套件模板，
// 确认任务书、报告格式、收敛检查、收口用法写进了文档，且报告模板的表头与代码里的栏目常量一致。
// 业务含义：规则只写在文档里、代码里另一套，改一边忘另一边就会让复审者按旧格式出报告被闸门拒绝；这里把两边对上。
// 运行：在仓库根目录 node --test evals/review-rules.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const REVIEW = read('plugin/skills/product-dev/references/review.md');
const GATE = 'components/engineering-kit/kit/gate';

/** 取从标题 start 开始、到下一个同级或更高级标题之前的一段（标题按行首 # 的个数判断；代码围栏里的 # 行是模板内容，不算标题）。 */
function section(text, startPattern) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => startPattern.test(l));
  assert.ok(i >= 0, `找不到标题：${startPattern}`);
  const depth = /^(#+)/.exec(lines[i])[1].length;
  let fence = null;
  let j = i + 1;
  for (; j < lines.length; j++) {
    const mark = /^\s*(`{3,}|~{3,})/.exec(lines[j]);
    if (mark) {
      if (!fence) fence = mark[1];
      else if (mark[1][0] === fence[0] && mark[1].length >= fence.length) fence = null;
      continue;
    }
    if (!fence && /^(#+)\s/.test(lines[j]) && /^(#+)/.exec(lines[j])[1].length <= depth) break;
  }
  return lines.slice(i, j).join('\n');
}
/** Markdown 表头行里的栏名。 */
const cells = (line) => line.split('|').slice(1, -1).map((c) => c.trim());
/** 文本里第一条以 | 开头、含全部给定栏名的表头行。 */
const headerLine = (text, mustHave) => text.split('\n').find((l) => l.trim().startsWith('|') && mustHave.every((c) => l.includes(c)));

test('A1 首轮任务书：写明只给必要上下文，不贴代码、不给作者结论', () => {
  const first = section(REVIEW, /^### 首轮任务书/);
  assert.match(first, /必要上下文/);
  assert.match(first, /不贴代码/);
  assert.match(first, /不给作者结论/);
});

test('A2 第 7 节报告模板：发现表头是七栏，且与 report.mjs 的 FINDING_COLUMNS 一致', async () => {
  const { FINDING_COLUMNS } = await import(`../${GATE}/report.mjs`);
  assert.deepEqual(FINDING_COLUMNS, ['编号', '级别', '位置', '问题', '触发条件或例子', '理由', '建议改法']);
  const s7 = section(REVIEW, /^## 7\./);
  const line = headerLine(s7, ['编号', '级别', '建议改法']);
  assert.ok(line, '第 7 节的报告模板里有发现表头');
  assert.deepEqual(cells(line), FINDING_COLUMNS);
});

test('A2 任务书：要求中高风险发现写理由和推荐措施、首轮尽量一次报全', () => {
  const tasks = section(REVIEW, /^## 2\. 任务书/);
  assert.match(tasks, /理由/);
  assert.match(tasks, /推荐措施|建议改法/);
  assert.match(tasks, /一次报全|一次给全|尽量报全/);
});

test('A5 任务书：中高风险的复审要做测试缺口检查（功能是否都有测试、层级是否齐全、边界是否覆盖）', () => {
  const tasks = section(REVIEW, /^## 2\. 任务书/);
  assert.match(tasks, /测试缺口/);
  assert.match(tasks, /层级/);
  assert.match(tasks, /边界/);
});

test('A7 修后复核任务书：最后一轮写明“这是最后一轮”，逐条列清理由和彻底解决办法', () => {
  const tasks = section(REVIEW, /^## 2\. 任务书/);
  assert.match(tasks, /最后一轮/);
  assert.match(tasks, /彻底解决/);
});

test('A10 第 8 节收敛检查：同类问题反复出现、级别升高或数量增加时先停下向用户汇报，建议专项处理', () => {
  const s8 = section(REVIEW, /^## 8\./);
  const conv = section(s8, /^###.*收敛/);
  assert.match(conv, /先停下向用户汇报/);
  assert.match(conv, /专项/);
});

test('A6 收口一节：写明 review.mjs close 的用法、风险登记与 --report、--summary', () => {
  const s8 = section(REVIEW, /^## 8\./);
  const closure = section(s8, /^###.*收口/);
  assert.match(closure, /review\.mjs close/);
  assert.match(closure, /--pr/);
  assert.match(closure, /--report/);
  assert.match(closure, /--summary/);
  assert.match(closure, /风险登记/);
  assert.match(closure, /已修、未再复审/);
});

test('A6 风险登记模板存在，表头是十栏且与 risks.mjs 的 REGISTER_COLUMNS 一致', async () => {
  const rel = 'components/engineering-kit/kit/templates/docs/templates/review-risks.md';
  assert.ok(fs.existsSync(path.join(ROOT, rel)), `缺少模板 ${rel}`);
  const { REGISTER_COLUMNS } = await import(`../${GATE}/risks.mjs`);
  assert.deepEqual(REGISTER_COLUMNS, ['编号', 'PR', '提交', '轮次', '级别', '位置', '问题', '理由', '推荐措施', '状态']);
  const line = headerLine(read(rel), ['编号', 'PR', '推荐措施', '状态']);
  assert.ok(line, '模板里有风险登记表头');
  assert.deepEqual(cells(line), REGISTER_COLUMNS);
});
