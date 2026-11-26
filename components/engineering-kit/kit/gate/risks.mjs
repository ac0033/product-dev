// 风险登记核对：把收口时的每个中级编号对应到最终提交里独立的一行处置记录。
import { hasContent, readTables, severityOf } from './report.mjs';

/** 风险登记的十栏，解析按名匹配，展示按此顺序。 */
export const REGISTER_COLUMNS = ['编号', 'PR', '提交', '轮次', '级别', '位置', '问题', '理由', '推荐措施', '状态'];
/** 收口登记要求的状态前缀，后面可附修复说明。 */
export const FIXED_STATUS = '已修、未再复审';

/** 从 Markdown 读取风险登记行，保留原始文本以核对 PR、提交前缀与轮次。 */
export function parseRegister(text) {
  const table = readTables(text, REGISTER_COLUMNS);
  const rows = table.rows.map((r) => ({
    id: r.编号, pr: r.PR, commit: r.提交, round: r.轮次, severity: r.级别,
    location: r.位置, problem: r.问题, reason: r.理由, fix: r.推荐措施, status: r.状态,
  }));
  return { rows, problems: table.problems };
}

/** 逐条核对最新一轮的中级发现；每个合格的登记行只抵一个编号，返回所有缺项。 */
export function registerProblems(text, { pr, failHead, round, mediumIds }) {
  const { rows, problems } = parseRegister(text);
  const available = new Map();
  for (const row of rows) {
    if (row.pr.replace(/^#/, '') !== String(pr) || row.round !== String(round)) continue;
    if (!/^[a-f0-9]{7,}$/i.test(row.commit) || !failHead?.startsWith(row.commit.toLowerCase())) continue;
    if (severityOf(row.severity) !== 'medium' || !row.status.startsWith(FIXED_STATUS)) continue;
    if (![row.location, row.problem, row.reason, row.fix].every(hasContent)) continue;
    available.set(row.id, (available.get(row.id) ?? 0) + 1);
  }
  for (const id of mediumIds) {
    const count = available.get(id) ?? 0;
    if (count) available.set(id, count - 1);
    else problems.push('风险登记缺少编号 ' + id + ' 对应的合格中级处置记录');
  }
  return problems;
}
