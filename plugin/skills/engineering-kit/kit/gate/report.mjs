// 复审报告解析：从 Markdown 区分正文、示例围栏、必需的节和结论。
/** 转义正则特殊字符，使配置的结论关键词可以安全地放进正则。 */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 去掉 Markdown 修饰（星号、下划线、反引号）和首尾空白，留下文字本身。 */
function plain(s) {
  return s.replace(/[*_`]/g, '').trim();
}

/** 结论词后紧跟括号的写法（如“通过（待 M2 修复后）”“通过（或 不通过）”）：不认，提示里说明。 */
const BRACKETED = /^(?:通过|不通过|未通过)\s*[（(]/;

/**
 * 一段文字是不是单独的结论词：通过 / 不通过 / 未通过（只认这三个中文词；允许句末标点）。返回 pass、fail、bracketed 或 null。
 * 结论词后带括号的返回 bracketed（不算结论）：括号里常是“待修复后”“或 不通过”这类让结论不再确定的话。
 */
function verdictWord(s) {
  const t = plain(s).replace(/[。.！!]+$/, '').trim();
  if (t === '通过') return 'pass';
  if (t === '不通过' || t === '未通过') return 'fail';
  if (BRACKETED.test(t)) return 'bracketed';
  return null;
}

/**
 * 两种写法共用的判定规则：把结论文字按 `，,；;。：:` 拆成小句，去掉修饰符号后整句恰好是结论词的小句才算。
 * 返回 { verdict: 'pass'|'fail'|'conflict'|null, bracketed }（conflict：同一处既有通过又有不通过；bracketed：有结论词后带括号的小句）。
 * 所以“有 2 个高级问题，不通过”是不通过，“通过。一句话理由”“不通过：H1 未修复”都认得出，
 * “通过前需修复 H1”“通过与否取决于…”“通过（待 M2 修复后）”都不算结论。
 */
function clauseVerdict(s) {
  const all = s.replace(/^[\s>-]*/, '').split(/[，,；;。：:]/).map(verdictWord);
  const words = new Set(all.filter((w) => w === 'pass' || w === 'fail'));
  const bracketed = all.includes('bracketed');
  if (words.size > 1) return { verdict: 'conflict', bracketed };
  return { verdict: words.size === 1 ? [...words][0] : null, bracketed };
}

/**
 * 逐行标出代码围栏。围栏用三个以上的反引号或波浪线开头（开头行的说明文字允许有，反引号围栏的说明文字里不能再有反引号），
 * 闭合行要用同一种字符、个数不少于开头、后面没有别的文字（CommonMark 的写法），所以四个反引号的围栏里可以放三个反引号的模板。
 * 比 CommonMark 宽松的地方：围栏标记前的缩进不限（CommonMark 只允许三个空格内，便于列表里缩进的围栏）；写在引用块（“>”开头）里的围栏不认。
 * 返回 { lines, unclosedAt }：lines 的每项是 { text, fenced, marker }（fenced 是在围栏内，含两条围栏标记行；marker 是围栏标记行本身）；
 * unclosedAt 是没闭合的围栏开头所在行号（从 1 数），都闭合了为 null。围栏没闭合时，其后的全部行都按围栏内处理。
 */
export function markFences(text) {
  const lines = [];
  let open = null; // { ch, len, at }
  String(text).split(/\r?\n/).forEach((raw, i) => {
    if (open) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(raw);
      if (close && close[1][0] === open.ch && close[1].length >= open.len) {
        open = null;
        lines.push({ text: raw, fenced: true, marker: true });
      } else lines.push({ text: raw, fenced: true, marker: false });
      return;
    }
    const start = /^\s*(`{3,}|~{3,})(.*)$/.exec(raw);
    if (start && !(start[1][0] === '`' && start[2].includes('`'))) {
      open = { ch: start[1][0], len: start[1].length, at: i + 1 };
      lines.push({ text: raw, fenced: true, marker: true });
    } else lines.push({ text: raw, fenced: false, marker: false });
  });
  return { lines, unclosedAt: open ? open.at : null };
}

/** 围栏没闭合时给提示用的说明：围栏里的行不能当标题或结论，没闭合时其后的内容全被当成围栏。没有未闭合的围栏返回空串。 */
export function fenceHint(text) {
  const { unclosedAt } = markFences(text);
  return unclosedAt === null ? '' : `；报告里第 ${unclosedAt} 行起的代码围栏没有闭合（要用同一种围栏符号再写一行结束），围栏里的行不当标题或结论，其后的各节和结论都会认不出`;
}

/**
 * 从报告里找出明确的结论。认两种写法（keyword 默认是“结论”，可配置），判定规则相同（clauseVerdict）：
 *   同一行：`结论：……`，行首允许井号、引用符、列表符，词两边允许星号，判定冒号后的文字。
 *   标题行：只有关键词的一行（如 `## 结论`），判定其后第一个非空行。
 * 代码围栏里的行（含围栏标记行）不参与：报告把第 7 节模板原样放进围栏时，里面的“结论：通过”不能当真，标题行之后找“第一个非空行”也跳过围栏。
 * 返回 { verdict: 'pass'|'fail'|null, conflict, bracketed }：找不到时 verdict 为 null；出现多处且不一致时 conflict 为 true、verdict 为 null；
 * bracketed 表示有结论词后带括号的写法（没认作结论），提示里据此说明。
 */
export function reportVerdict(text, keyword = '结论') {
  const k = escapeRe(keyword);
  const heading = new RegExp(`^[\\s>#*_-]*${k}[\\s*_]*[:：]?[\\s*_]*$`);
  const inline = new RegExp(`^[\\s>#*_-]*${k}(?:[\\s*_]*[:：]|[\\s*_]+)[\\s*_]*(.+)$`);
  const { lines } = markFences(text);
  const found = [];
  let bracketed = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].fenced) continue;
    let body = null;
    if (heading.test(lines[i].text)) body = lines.slice(i + 1).find((l) => !l.fenced && l.text.trim() !== '')?.text ?? null;
    else body = inline.exec(lines[i].text)?.[1] ?? null;
    if (body === null) continue;
    const v = clauseVerdict(body);
    if (v.bracketed) bracketed = true;
    if (v.verdict === 'conflict') found.push('pass', 'fail');
    else if (v.verdict) found.push(v.verdict);
  }
  const kinds = new Set(found);
  if (kinds.size > 1) return { verdict: null, conflict: true, bracketed };
  return { verdict: kinds.size === 1 ? [...kinds][0] : null, conflict: false, bracketed };
}

/**
 * 报告里缺哪几节。一节算有，要同时满足：
 *   标题行：井号加空格开头（可带编号，如“## 1. 范围”“### 一、范围”），标题文字以节名开头，其后是空白、括号、冒号或行尾；或同一行写“节名：内容”
 *     （行首可以有引用符、列表符、星号；有井号的话和标题行一样，井号后要有空格，“##范围：x”不认）；
 *   有内容：标题行之后、下一个同级或更高级标题之前至少有一个非空、非标题的行（更深一级的子标题本身不算内容）；同一行写法的冒号后要有字。
 * 代码围栏（```）里的行不能当标题，防止把模板原样放进围栏冒充各节；围栏里写的内容算所在一节的内容（例如“作者的验证”下直接贴测试输出），
 * 但围栏标记行本身不算：只有两行围栏标记、里面什么也没有的空围栏不算有内容。围栏没闭合时其后的行都按围栏内处理（markFences）。节名只比较文字，不分大小写。
 */
export function missingSections(text, sections) {
  const { lines } = markFences(text);
  const level = (l) => (l.fenced ? 0 : (/^\s{0,3}(#{1,6})\s/.exec(l.text)?.[1].length ?? 0));
  return sections.filter((name) => {
    const n = escapeRe(name);
    const head = new RegExp(`^\\s{0,3}(#{1,6})\\s+(?:\\d+[.、)）]?\\s*|[一二三四五六七八九十]+[、.]\\s*)?[*_]*${n}[*_]*(?:[\\s（(:：]|$)`, 'i');
    // 行首的引用符、列表符、井号各自吃掉自己后面的空白，组内不再另留 \s*：同一段空白只有一种分法，匹配失败时回溯量与行长成正比（有计时测试）
    const inline = new RegExp(`^\\s*(?:(?:#{1,6}|[-*+])[ \\t]+|>[ \\t]*)*[*_]*${n}[\\s*_]*[:：][\\s*_]*\\S`, 'i');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].fenced) continue;
      if (inline.test(lines[i].text)) return false;
      const m = head.exec(lines[i].text);
      if (!m) continue;
      const depth = m[1].length;
      for (let j = i + 1; j < lines.length; j++) {
        const lv = level(lines[j]);
        if (lv > 0 && lv <= depth) break;
        if (lv === 0 && !lines[j].marker && lines[j].text.trim() !== '') return false;
      }
    }
    return true;
  });
}

/** 发现表的标准栏名按展示顺序排列，解析时按名字取列。 */
export const FINDING_COLUMNS = ['编号', '级别', '位置', '问题', '触发条件或例子', '理由', '建议改法'];
/** 建议改法以此词开头时，该轮须停下汇报。 */
export const UNRESOLVABLE = '无法彻底解决';
/** 协议级别对应的中文展示名，供外部报告渲染与解析共用。 */
export const SEVERITIES_CN = { high: '高级', medium: '中级', low: '低级', info: '提示' };

const SEVERITY = new Map([
  ['高', 'high'], ['高级', 'high'], ['h', 'high'], ['high', 'high'],
  ['中', 'medium'], ['中级', 'medium'], ['m', 'medium'], ['medium', 'medium'],
  ['低', 'low'], ['低级', 'low'], ['l', 'low'], ['low', 'low'],
  ['提示', 'info'], ['info', 'info'],
]);

/** 统一报告和登记表内的级别写法，未知值交给调用方报告。 */
export function severityOf(value) {
  return SEVERITY.get(plain(value).toLowerCase());
}

/** 空白、纯修饰和约定的占位词均不能作为理由或处置依据。 */
export function hasContent(value) {
  return !/^(?:无|暂无|待补|-|—|\/|n\/a|tbd)?$/i.test(plain(value ?? ''));
}

/** 读取有边界的 Markdown 表格行，还原转义的竖线和反斜杠。 */
function cells(line) {
  const s = line.trim();
  if (!s.startsWith('|') || !s.endsWith('|')) return null;
  const out = [];
  let cell = '';
  for (let i = 1; i < s.length - 1; i++) {
    if (s[i] === '\\' && i + 1 < s.length - 1 && ['|', '\\'].includes(s[i + 1])) cell += s[++i];
    else if (s[i] === '|') {
      out.push(cell.trim());
      cell = '';
    } else cell += s[i];
  }
  out.push(cell.trim());
  return out;
}

/** 去掉一行里 HTML 注释（<!-- … -->，可跨行）的部分；state.comment 记录上一行结束时是否还在注释里。 */
function visiblePart(text, state) {
  let visible = '';
  let rest = text;
  while (rest) {
    if (state.comment) {
      const end = rest.indexOf('-->');
      if (end < 0) return visible;
      state.comment = false;
      rest = rest.slice(end + 3);
    } else {
      const start = rest.indexOf('<!--');
      if (start < 0) return visible + rest;
      visible += rest.slice(0, start);
      state.comment = true;
      rest = rest.slice(start + 4);
    }
  }
  return visible;
}

/**
 * 只取发现节（含下级标题）的表；围栏、其他节和同一行写法之后的新节都隔断表格。section 是发现节的节名（默认“发现”，
 * 项目在 reviewSections 里改了节名时由调用方传入）。HTML 注释在 Markdown 里看不见，注释里的表不当证据（发现表和风险登记都一样）。
 */
function tableLines(text, findingsOnly, section = '发现') {
  const name = escapeRe(section);
  const headingRe = new RegExp(`^${name}(?:[\\s（(:：]|$)`);
  const inlineRe = new RegExp(`^\\s*(?:[-+*>]\\s*)*${name}\\s*[:：]`);
  const state = { comment: false };
  let depth = 0;
  return markFences(text).lines.map((line) => {
    if (line.fenced) return '';
    const shown = visiblePart(line.text, state);
    if (!findingsOnly) return shown;
    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(shown);
    if (heading) {
      const title = plain(heading[2]).replace(/^(?:\d+[.、)）]?\s*|[一二三四五六七八九十]+[、.]\s*)/, '');
      if (headingRe.test(title)) depth = heading[1].length;
      else if (heading[1].length <= depth) depth = 0;
    } else if (inlineRe.test(plain(shown))) depth = 7;
    else if (depth === 7 && /^\s*(?:范围|作者的验证|结论|处置)\s*[:：]/.test(plain(shown))) depth = 0;
    return depth ? shown : '';
  });
}

/** 按必需栏名读取有分隔行的表，返回原始列值与格式问题，供发现表和风险登记共用。 */
export function readTables(text, columns, { findingsOnly = false, aliases = {}, section } = {}) {
  const lines = tableLines(text, findingsOnly, section);
  const rows = [];
  const problems = [];
  let tables = 0;
  for (let i = 0; i + 1 < lines.length; i++) {
    const header = cells(lines[i])?.map((v) => Object.hasOwn(aliases, plain(v)) ? aliases[plain(v)] : plain(v));
    const separator = header && cells(lines[i + 1]);
    // 头两栏（发现表的编号、级别，风险登记的编号、PR）都在才算候选表：同一节里附带的取证表不当成不合格的发现表
    if (!header || !columns.slice(0, 2).every((c) => header.includes(c)) || !separator?.every((v) => /^:?-{3,}:?$/.test(v))) continue;
    tables++;
    const missing = columns.filter((v) => !header.includes(v));
    if (missing.length) problems.push('表头缺：' + missing.join('、'));
    if (header.length !== separator.length || new Set(header).size !== header.length) problems.push('表头列数不符或栏名重复');
    i++;
    let values;
    while (i + 1 < lines.length && (values = cells(lines[i + 1]))) {
      i++;
      if (values.length !== header.length) problems.push('表格行列数与表头不符：' + values[0]);
      if (!missing.length) rows.push(Object.fromEntries(header.map((name, j) => [name, values[j] ?? ''])));
    }
  }
  if (!tables) problems.push('找不到可解析的表头：' + columns.join('、'));
  return { rows, problems };
}

/** 解析报告发现表，保留逐行诊断，同时生成登记与轮次判定需要的计数。section 是发现节的节名。 */
function inspectFindings(text, section) {
  const table = readTables(text, FINDING_COLUMNS, { findingsOnly: true, aliases: { 推荐措施: '建议改法' }, section });
  const findings = { parsed: 0, high: 0, medium: 0, low: 0, info: 0, unresolvable: 0, highIds: [], mediumIds: [], rows: [] };
  const problems = [...table.problems];
  for (const [index, fields] of table.rows.entries()) {
    const rawId = fields.编号.trim();
    const mark = /\s+(既有|修复新增|原先漏检|重复出现)$/.exec(rawId);
    const id = mark ? rawId.slice(0, mark.index) : rawId;
    const severity = severityOf(fields.级别);
    if (!id || !severity) {
      problems.push('第 ' + (index + 1) + ' 行编号或级别不可识别：' + rawId + ' ' + fields.级别);
      continue;
    }
    const row = { id, mark: mark?.[1] ?? null, severity, location: fields.位置, problem: fields.问题, trigger: fields.触发条件或例子, reason: fields.理由, fix: fields.建议改法 };
    findings.rows.push(row);
    findings.parsed++;
    findings[severity]++;
    if (severity === 'high') findings.highIds.push(id);
    if (severity === 'medium') findings.mediumIds.push(id);
    if (plain(row.fix).startsWith(UNRESOLVABLE)) findings.unresolvable++;
    const gaps = findingGaps(row);
    if (gaps.length) problems.push('第 ' + (index + 1) + ' 行（' + id + '）缺：' + gaps.join('、'));
  }
  if (!findings.parsed) problems.push('发现表至少要有一行可识别的发现');
  return { findings, problems };
}

/** 从报告正文返回逐行发现及其统计，用于登记、渲染自检和轮次核对。section 是发现节的节名（默认“发现”）。 */
export function parseFindings(text, { section } = {}) {
  return inspectFindings(text, section).findings;
}

/** 项目配置的报告节里发现节叫什么：取 reviewSections 里第一个含“发现”的节名，没有时为“发现”。 */
export function findingsSection(reviewSections = []) {
  return reviewSections.find((s) => s.includes('发现')) ?? '发现';
}

/** 登记记录里保留的高、中级发现（编号、标记、级别、位置、问题）：风险登记按它逐条对应，收敛提示按它比较。 */
export function seriousIssues(rows) {
  return rows.filter((r) => r.severity === 'high' || r.severity === 'medium')
    .map(({ id, mark, severity, location, problem }) => ({ id, mark, severity, location, problem }));
}

/** 给出一条中高级发现缺少的必填栏名（位置、问题、触发条件、理由、建议改法都要写）；低级与提示行没有此要求。 */
export function findingGaps(row) {
  if (!['high', 'medium'].includes(row.severity)) return [];
  const gaps = [];
  if (!hasContent(row.location)) gaps.push('位置');
  if (!hasContent(row.problem)) gaps.push('问题');
  if (!hasContent(row.trigger)) gaps.push('触发条件或例子');
  if (!hasContent(row.reason)) gaps.push('理由');
  if (!hasContent(row.fix)) gaps.push('建议改法');
  return gaps;
}

/** 从报告正文列出拒绝 fail 或 accept 登记的全部发现表问题。section 是发现节的节名（默认“发现”），找不到表时提示里写明节名。 */
export function findingProblems(text, { section = '发现' } = {}) {
  return inspectFindings(text, section).problems.map((p) => (p.startsWith('找不到可解析的表头') ? `“${section}”一节里${p}` : p));
}
