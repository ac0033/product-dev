// 复审数据的判定与展示。登记和外部执行器共用规则，Markdown 仅供人阅读。
import { createHash } from 'node:crypto';

export const REVIEW_FORMAT = 'ek-review/1';
export const SEVERITY_PREFIX = { high: 'H', medium: 'M', low: 'L', info: 'I' };
export const SEVERITIES = Object.keys(SEVERITY_PREFIX);
export const TAGS = ['既有', '修复新增', '原先漏检'];
export const DISPOSITIONS = ['fixed', 'partial', 'not-fixed'];
export const GAP_STATUSES = ['verified', 'gap', 'insufficient', 'n/a'];
export const GAP_ITEMS = ['functions', 'layers', 'boundaries'];
export const PLACEHOLDERS = ['无', '暂无', '待补', '待定', '-', '—', '/', 'n/a', 'na', 'tbd', 'todo', 'none'];
export const MAX_REVIEW_BYTES = 512 * 1024;
const fields = ['location', 'problem', 'trigger', 'reason', 'fix'];
const idPattern = /^[HMLI][1-9]\d*$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isSerious = (f) => ['high', 'medium'].includes(f?.severity);

/** 判断文字是否给出了实际内容：去掉不可见字符和 HTML 字符实体后要有文字或数字，去掉标点、符号和空白后也不能只剩占位词（“无。”“（暂无）”同样算没写）。 */
export function hasContent(s) {
  if (typeof s !== 'string') return false;
  const clean = s.replace(/\p{Cf}|\p{Default_Ignorable_Code_Point}|&(?:[A-Za-z][A-Za-z0-9]*|#\d+|#x[0-9a-fA-F]+);/gu, '').trim();
  const bare = clean.replace(/[\p{P}\p{S}\p{Z}\s]+/gu, '').toLowerCase();
  return /[\p{L}\p{N}]/u.test(clean) && !PLACEHOLDERS.includes(clean.toLowerCase()) && !PLACEHOLDERS.includes(bare);
}

/** 不是仓库相对 POSIX 路径：含反斜杠、盘符开头，或有空段、`.`、`..`。 */
const badRepoPath = (file) => file.includes(String.fromCharCode(92)) || /^[a-z]:/i.test(file) || file.split('/').some((part) => ['', '.', '..'].includes(part));

/** 检查文本类型、长度、不可见字符及必填内容，每栏报告一个具体问题。 */
function textIssue(s, { single = false, required = false, max = 4000 } = {}) {
  if (typeof s !== 'string') return '必须是字符串';
  if ([...s].length > max) return `超过 ${max} 字`;
  const checked = single ? s : s.replace(/[\n\t]/g, '');
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(checked)) return '含控制字符或不可见字符';
  if (required && !hasContent(s)) return '没有内容';
  return null;
}

/** 按字段位置收集全部问题，避免不合法的嵌套类型中断其余检查。 */
export function validateReviewData(data, { sections = [], flow, minChars = 0 } = {}) {
  const errors = [];
  function object(v, at, keys) {
    if (!isObject(v)) { errors.push(`${at} 必须是对象`); return false; }
    for (const k of Object.keys(v)) if (!keys.includes(k)) errors.push(`${at} 含未定义字段 ${k}`);
    return true;
  }
  function checkText(v, at, opts) {
    const issue = textIssue(v, opts);
    if (issue) errors.push(`${at}：${issue}`);
  }
  function choice(v, at, options) {
    if (!options.includes(v)) errors.push(`${at} 必须是 ${options.join('、')}`);
  }
  function checkId(v, at, seen) {
    if (typeof v !== 'string' || !idPattern.test(v)) errors.push(`${at} 编号格式错误`);
    if (typeof v === 'string' && seen?.has(v)) errors.push(`${at} 编号 ${v} 重复`);
    seen?.add(v);
  }
  if (!object(data, '复审数据', ['format', 'kind', 'risk', 'verdict', 'reviewedCommit', 'reviewedBase', 'sections', 'findings', 'testGaps', 'dispositions', 'unreviewedFiles', 'priorFailSha'])) return errors;
  choice(data.format, 'format', [REVIEW_FORMAT]);
  choice(data.kind, 'kind', ['code', 'consistency']);
  choice(data.verdict, 'verdict', ['pass', 'fail']);
  choice(data.risk, 'risk', ['low', 'high']);
  for (const k of ['reviewedCommit', 'reviewedBase']) {
    if (flow !== 'pr' && data[k] === null) continue;
    if (typeof data[k] !== 'string' || !/^[0-9a-f]{40}$/.test(data[k])) errors.push(`${k} 须为 40 位小写十六进制提交号`);
  }
  if ('unreviewedFiles' in data) {
    if (!Array.isArray(data.unreviewedFiles)) errors.push('unreviewedFiles 须为数组');
    else {
      if (new Set(data.unreviewedFiles).size !== data.unreviewedFiles.length) errors.push('unreviewedFiles 有重复路径');
      for (const file of data.unreviewedFiles) {
        checkText(file, 'unreviewedFiles', { single: true, required: true });
        if (typeof file === 'string' && badRepoPath(file)) errors.push(`unreviewedFiles 须为仓库相对路径：${file}`);
      }
    }
  }
  if ('priorFailSha' in data && data.priorFailSha !== null && (typeof data.priorFailSha !== 'string' || !/^[0-9a-f]{64}$/.test(data.priorFailSha))) errors.push('priorFailSha 须为 64 位小写十六进制指纹或 null');
  let chars = 0;
  if (!isObject(data.sections)) errors.push('sections 须为对象');
  else {
    for (const name of sections) if (name !== '发现' && !Object.hasOwn(data.sections, name)) errors.push(`sections 缺少必需的节：${name}`);
    for (const [name, value] of Object.entries(data.sections)) {
      if (!name.trim()) errors.push('sections 节名为空');
      checkText(name, 'sections 节名', { single: true, max: 40 });
      checkText(value, `sections 的 ${name}`, { required: true, max: 20000 });
      if (typeof value === 'string') chars += [...value.trim()].length;
    }
  }
  const seen = new Set();
  const serious = new Set();
  if (!Array.isArray(data.findings)) errors.push('findings 须为数组');
  else {
    if (data.findings.length > 200) errors.push('findings 超过 200 条');
    data.findings.forEach((f, i) => {
      const at = `第 ${i + 1} 条发现（${typeof f?.id === 'string' ? f.id : '编号缺失'}）`;
      if (!object(f, at, ['id', 'severity', ...fields, 'files', 'unresolvable', 'systemic', 'tag', 'prior'])) return;
      choice(f.severity, `${at} severity`, SEVERITIES);
      checkId(f.id, `${at} id`, seen);
      if (typeof f.id === 'string' && (f.id.length > 4000 || (SEVERITIES.includes(f.severity) && f.id[0] !== SEVERITY_PREFIX[f.severity]))) errors.push(`${at} id 长度或级别前缀不符`);
      if (isSerious(f) && typeof f.id === 'string') serious.add(f.id);
      for (const k of fields) {
        checkText(f[k], `${at} ${k}`, { single: k === 'location', required: isSerious(f) || k === 'problem' });
        if (typeof f[k] === 'string') chars += [...f[k].trim()].length;
      }
      for (const k of ['unresolvable', 'systemic']) if (k in f && typeof f[k] !== 'boolean') errors.push(`${at} ${k} 须为布尔值`);
      if (f.tag != null) choice(f.tag, `${at} tag`, TAGS);
      if (f.prior != null) { checkId(f.prior, `${at} prior`); checkText(f.prior, `${at} prior`, { single: true }); }
      if ('files' in f) {
        if (!Array.isArray(f.files) || !f.files.length) errors.push(`${at} files 须为非空数组`);
        else {
          if (new Set(f.files).size !== f.files.length) errors.push(`${at} files 有重复路径`);
          for (const file of f.files) {
            checkText(file, `${at} files`, { single: true });
            if (typeof file === 'string' && (/\\|^[a-z]:/i.test(file) || file.split('/').some((part) => ['', '.', '..'].includes(part)))) errors.push(`${at} files 须为仓库相对路径：${file}`);
          }
        }
      }
    });
    if (data.verdict === 'pass' && serious.size) errors.push(`通过结论与高、中级发现 ${[...serious].join('、')} 矛盾`);
    if (data.verdict === 'fail' && !serious.size) errors.push('不通过结论没有高、中级发现');
  }
  if (chars < minChars) errors.push(`复审报告不少于 ${minChars} 字（当前 ${chars} 字）`);
  if (data.risk === 'high' || data.testGaps != null) {
    if (object(data.testGaps, 'testGaps', GAP_ITEMS)) for (const k of GAP_ITEMS) {
      const at = `testGaps.${k}`;
      const g = data.testGaps[k];
      if (!object(g, at, ['status', 'note', 'findings'])) continue;
      choice(g.status, `${at} status`, GAP_STATUSES);
      checkText(g.note, `${at} note`, { required: true });
      if (g.status === 'insufficient' && data.verdict === 'pass') errors.push(`${at} 证据不足，不能通过`);
      if ('findings' in g || g.status === 'gap') {
        const listed = g.findings;
        if (!Array.isArray(listed) || listed.some((id) => typeof id !== 'string' || !seen.has(id))) {
          errors.push(`${at} findings 须为有效的发现编号数组`);
        } else if (g.status === 'gap' && (!listed.length || listed.some((id) => !serious.has(id)))) {
          errors.push(`${at} findings 有缺口须列出对应高、中级编号`);
        }
      }
    }
  }
  if ('dispositions' in data) {
    const ids = new Set();
    if (!Array.isArray(data.dispositions)) errors.push('dispositions 须为数组');
    else data.dispositions.forEach((d, i) => {
      const at = `dispositions 第 ${i + 1} 项`;
      if (!object(d, at, ['id', 'status', 'evidence'])) return;
      checkId(d.id, `${at} id`, ids);
      checkText(d.id, `${at} id`, { single: true });
      choice(d.status, `${at} status`, DISPOSITIONS);
      checkText(d.evidence, `${at} evidence`, { required: true });
      if (data.verdict === 'pass' && ['partial', 'not-fixed'].includes(d.status)) errors.push(`${at} 为 ${d.status}，不能通过`);
    });
  }
  if (!errors.length && Buffer.byteLength(canonicalJson(data)) > MAX_REVIEW_BYTES) errors.push('复审数据超过 512 KiB');
  return errors;
}

/** 结论由高、中级发现决定。 */
export const verdictOf = (findings) => findings.some(isSerious) ? 'fail' : 'pass';

/** 递归排序对象键，保留数组顺序；文件原始字节也采用这份表示。 */
export const canonicalJson = (data) => JSON.stringify(data, (_, v) =>
  isObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);
export const fingerprint = (data) => createHash('sha256').update(canonicalJson(data)).digest('hex');

/** 历史只留轮次与处置核对所需的摘要。 */
export const compactFindings = (findings) => findings.map(({ id, severity, files = [], unresolvable = false, systemic = false, prior = null }) =>
  ({ id, severity, files, unresolvable, systemic, prior }));

/** 判断被审范围能否从分叉点或已有同种完整登记连续覆盖到被审提交。 */
export function coverageOf({ reviewedBase, reviewedCommit, forkPoint, coveredCommits = [], baseIsAncestor, unreviewedFiles = [] }) {
  let why = '';
  if (unreviewedFiles.length) why = `以下改动文件没有交给复审者：${unreviewedFiles.join('、')}；这部分须由能看到它们的复审者完整复审后才能放行`;
  else if (reviewedBase === reviewedCommit) why = '基准等于被审提交，未覆盖任何差异';
  else if (!baseIsAncestor) why = `基准 ${reviewedBase} 不是被审提交 ${reviewedCommit} 的祖先`;
  else if (reviewedBase !== forkPoint && !coveredCommits.includes(reviewedBase)) why = `从分叉点 ${forkPoint ?? '（未知）'} 到基准 ${reviewedBase} 缺少同种审查的完整覆盖`;
  return { full: !why, why };
}

/** 从属于本 PR 的历史中找到上次待处置的失败审查。 */
export const previousFail = (prior, kind, head) => prior.findLast((r) => r.kind === kind && r.verdict === 'fail' && r.headSha !== head);

/** 同一提交核对也供传入 gh 的既有适配接口使用。 */
export function reviewedHeadProblem(reviewedCommit, prHead) {
  if (reviewedCommit === prHead) return null;
  return `复审者审的是 ${reviewedCommit.slice(0, 12)}，PR 现在是 ${prHead.slice(0, 12)}（PR 最终提交已变为 ${prHead.slice(0, 12)}），不能登记`;
}

/** 汇总结构合格的数据与真实 PR、文件和历史之间的全部矛盾。 */
export function admissionProblems({ data, kind, verdict, flow, evidenceChecked, missingFiles = [], prHead, prior = [], coverage }) {
  const errors = [];
  if (data.kind !== kind) errors.push(`数据 kind 为 ${data.kind}，登记要求 ${kind}`);
  if (data.verdict !== (verdict === 'accept' ? 'fail' : verdict)) errors.push(verdict === 'accept' ? 'accept 要求报告结论为不通过' : `报告结论是 ${data.verdict}，不能记录为 ${verdict}`);
  if (data.risk === 'high' && !hasContent(evidenceChecked)) errors.push('中高风险须用 --evidence-checked 写明主对话核对的证据');
  for (const f of missingFiles) errors.push(`被审范围中找不到文件 ${f}`);
  if (coverage && ['accept', 'pass'].includes(verdict) && !coverage.full) errors.push(`只覆盖部分差异：${coverage.why}`);
  if (flow !== 'pr') return errors;
  const headProblem = reviewedHeadProblem(data.reviewedCommit, prHead);
  if (headProblem) errors.push(headProblem);
  if (['accept', 'pass'].includes(verdict)) {
    if (data.risk !== 'high' && prior.some((r) => r.risk === 'high' && ['pass', 'fail', 'accept'].includes(r.verdict))) errors.push('此前已按中高风险登记，本轮不能降低风险档位');
  }
  const prev = previousFail(prior, data.kind, data.reviewedCommit);
  if (data.priorFailSha && data.priorFailSha !== (prev?.dataSha ?? null)) errors.push(`复审依据的上一份不通过数据（${data.priorFailSha.slice(0, 12)}）不是当前登记历史里的上一份（${prev?.dataSha ? prev.dataSha.slice(0, 12) : '没有'}），按当前历史重新复核`);
  const ids = new Set((prev?.findings ?? []).filter(isSerious).map((f) => f.id));
  const dispositions = data.dispositions ?? [];
  for (const id of ids) if (!dispositions.some((d) => d.id === id)) errors.push(`缺少上轮 ${id} 的处置`);
  for (const d of dispositions) {
    if (!ids.has(d.id)) errors.push(`处置 ${d.id} 不在上轮待处置清单`);
    if (d.status !== 'fixed' && !data.findings.some((f) => isSerious(f) && f.prior === d.id)) errors.push(`处置 ${d.id} 未修好，须有本轮高、中级发现指向它`);
  }
  for (const f of data.findings) if (f.prior && !ids.has(f.prior)) errors.push(`${f.id} 引用的 prior ${f.prior} 不属于上轮高、中级发现`);
  return errors;
}

/** 转义 Markdown 标记与 HTML，保留单元格内的换行。 */
function escaped(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\|*_`\[\]#!~()+]/g, '\\$&');
}

/** 将验证过的数据生成供人核对的报告，所有自由文字均作纯文本。 */
export function renderReport(data, meta = {}) {
  const cell = (s) => escaped(s).replace(/\n/g, '<br>');
  const lines = [`# ${data.kind === 'code' ? '代码复审' : '一致性审'}报告`, '',
    `- 复审者：${cell(meta.reviewer)}`, `- 被审范围：${data.reviewedBase ?? '工作区基准'}..${data.reviewedCommit ?? '工作区'}`,
    `- 风险档位：${data.risk}`, `- 覆盖：${cell(meta.coverage ?? '登记时核对')}`, `- 指纹：${meta.fingerprint ?? fingerprint(data)}`];
  if (meta.model) lines.push(`- 实际模型：${cell(meta.model)}`);
  for (const line of meta.extraLines ?? []) lines.push(`- ${cell(line)}`);
  for (const [name, body] of Object.entries(data.sections)) {
    lines.push('', `## ${escaped(name)}`, '', ...body.split('\n').map((line) => `> ${escaped(line)}`));
  }
  lines.push('', '## 发现', '', '| 编号 | 级别 | 位置 | 问题 | 触发条件 | 理由 | 建议改法 |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const f of data.findings) lines.push(`| ${[f.id, f.severity, ...fields.map((k) => f[k])].map(cell).join(' | ')} |`);
  if (data.testGaps) {
    lines.push('', '## 测试缺口检查', '');
    for (const [item, g] of Object.entries(data.testGaps)) lines.push(`- ${item}（${g.status}）：${cell(g.note)} ${(g.findings ?? []).join('、')}`);
  }
  if (data.dispositions?.length) {
    lines.push('', '## 修后处置', '');
    for (const d of data.dispositions) lines.push(`- ${d.id}（${d.status}）：${cell(d.evidence)}`);
  }
  lines.push('', `## ${escaped(meta.keyword ?? '结论')}`, '', data.verdict === 'pass' ? '通过' : '不通过', '');
  return lines.join('\n');
}
