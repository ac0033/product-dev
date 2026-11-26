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

/** 比较登记行与报告里的文字：去掉修饰符号、合并空白后相同才算同一处。 */
const same = (a, b) => String(a ?? '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim() === String(b ?? '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();

/**
 * 逐条核对最新一轮的中级发现，返回所有缺项。每个合格的登记行只抵一条发现：编号相同，并且位置、问题与报告里那一条一致
 * （mediumIssues 来自登记时记下的发现；两份报告用了同一编号、指的却是不同问题时，各要一行自己的记录，抄两遍同一行不算）。
 * 没有 mediumIssues 的旧记录只按编号对应。
 */
export function registerProblems(text, { pr, failHead, round, mediumIds, mediumIssues }) {
  const { rows, problems } = parseRegister(text);
  const usable = rows.filter((row) =>
    row.pr.replace(/^#/, '') === String(pr) && row.round === String(round) &&
    /^[a-f0-9]{7,}$/i.test(row.commit) && Boolean(failHead?.startsWith(row.commit.toLowerCase())) &&
    severityOf(row.severity) === 'medium' && row.status.startsWith(FIXED_STATUS) &&
    [row.location, row.problem, row.reason, row.fix].every(hasContent));
  const wanted = Array.isArray(mediumIssues) ? mediumIssues : (mediumIds ?? []).map((id) => ({ id, location: null, problem: null }));
  for (const issue of wanted) {
    const exact = issue.location !== null && issue.problem !== null;
    const at = usable.findIndex((row) => row.id === issue.id && (!exact || (same(row.location, issue.location) && same(row.problem, issue.problem))));
    if (at >= 0) usable.splice(at, 1);
    else problems.push('风险登记缺少编号 ' + issue.id + ' 对应的合格中级处置记录' + (exact ? '（位置、问题须照报告填写：' + issue.location + '，' + issue.problem + '）' : ''));
  }
  return problems;
}
