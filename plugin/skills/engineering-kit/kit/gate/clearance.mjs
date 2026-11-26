// 合并前的审查核对：判断文档差异和每份登记能否放行。
import fs from 'node:fs';
import { lastFailRound, ROUND_KEYS, roundMissing, roundState } from './rounds.mjs';
import { registerProblems } from './risks.mjs';
import { diffNames, git, isIgnoredDoc, prLogFile, prRecordFile, readLog, resolveBase } from './lib.mjs';

/**
 * 含代码的 PR 合并前要求的审查：代码复审必需；一致性审可以是 pass，也可以是写明理由的延期。两种都认 accept（用户接受风险）。
 * docsDelta 为 true 的审查（代码复审）在记录之后只改了文档时仍认。
 */
export const REQUIRED = [
  { kind: 'code', name: '代码复审', accept: ['pass', 'accept'], docsDelta: true },
  { kind: 'consistency', name: '一致性审', accept: ['pass', 'defer', 'accept'], docsDelta: false },
];

/**
 * 两个提交之间是否只改了文档（diffNames 的每个文件都是 isIgnoredDoc；改名按旧路径删除加新路径新增，代码改名进 docs/ 不算只改文档）。
 * 算不出差异（本地没有其中一个提交等）时返回 false。
 */
export function onlyDocsBetween(root, from, to, reviewIgnore) {
  const r = diffNames(root, [from, to]);
  return r.ok && r.files.every((f) => isIgnoredDoc(f, reviewIgnore));
}

/**
 * PR 是否只改文档（全部文件都是文档，判定同闸门的 isIgnoredDoc）：按分档表这类 PR 不做代码复审、一致性审并入巡检。
 * 文件列表取本地的 diffNames(<基准提交>, <PR 最终提交>)，基准提交是配置的基准分支与最终提交的 merge-base；
 * 不用 gh 返回的文件列表：改名时它可能只给新路径（代码 git mv 进 docs/ 就像只改文档），且最多 100 个。
 * reviewIgnore 是基准提交上的配置版本（loadConfig 得出的生效值），PR 分支自己改的 reviewIgnore 不算数；
 * 含项目配置、豁免表或 scripts/engineering/** 的 PR 不算只改文档。
 * 保守处理：本地没有最终提交、基准解析不了、算不出共同提交、差异算不出或为空时，都不算只改文档（要求审查记录）。
 * 返回 { docs, why }：前三种（本地缺提交或基准，git fetch 后可能就算得出）why 写明原因，合并入口放进 notes 并提示先 git fetch；
 * 差异算不出或为空时 why 为 null，不给提示。why 只是说明，不改变判定。
 */
export function docsOnlyPr(root, config, head) {
  const fetchHint = '：按含代码的 PR 处理（要求审查记录）；PR 若确实只改文档，先 git fetch 再运行合并入口';
  if (!git(root, ['cat-file', '-e', `${head}^{commit}`]).ok) return { docs: false, why: `本地没有 PR 最终提交 ${String(head).slice(0, 12)}，判断不了是否只改文档${fetchHint}` };
  let base;
  try {
    base = resolveBase(root, config.base);
  } catch (e) {
    return { docs: false, why: `基准分支解析不了（${e.message}），判断不了是否只改文档${fetchHint}` };
  }
  const mb = git(root, ['merge-base', base, head]);
  if (!mb.ok) return { docs: false, why: `本地算不出基准分支 ${base} 与最终提交的共同提交，判断不了是否只改文档${fetchHint}` };
  const r = diffNames(root, [mb.out.trim(), head]);
  return { docs: r.ok && r.files.length > 0 && r.files.every((f) => isIgnoredDoc(f, config.reviewIgnore)), why: null };
}

/** 读取一条 PR 审查记录；不存在或损坏返回 null（视为未登记）。 */
function readPrRecord(root, pr, kind) {
  try {
    return JSON.parse(fs.readFileSync(prRecordFile(root, pr, kind), 'utf8'));
  } catch {
    return null;
  }
}

/** 核对一项必需审查，返回拒绝原因和沿用记录时需要展示的说明。 */
export function recordClears(root, no, head, config, r) {
  const short = (sha) => String(sha).slice(0, 12);
  const problems = [];
  const notes = [];
  const rec = readPrRecord(root, no, r.kind);
  if (!rec) problems.push(`缺少${r.name}记录：先运行 review.mjs … --pr ${no} --kind ${r.kind}`);
  else if (!r.accept.includes(rec.verdict)) problems.push(`${r.name}结论是 ${rec.verdict}，不是 ${r.accept.join(' 或 ')}`);
  else if (!freshness(root, rec.headSha, head, config.reviewIgnore, r.docsDelta)) {
    problems.push(`${r.name}记录已过期：记录针对提交 ${short(rec.headSha)}，PR 当前最终提交是 ${short(head)}，需对新提交重新审查并登记`);
  } else {
    if (rec.headSha !== head) notes.push(`沿用${r.name}记录：记录针对提交 ${short(rec.headSha)}，到最终提交 ${short(head)} 之间只改了文档`);
    if (rec.verdict === 'accept') notes.push(`${r.name}结论为不通过，按用户决定接受风险放行（用户决定：${rec.userDecision}）`);
  }
  return { problems, notes };
}

/** 同提交记录直接生效，允许沿用文档改动时再按基准策略检查差异。 */
export function freshness(root, reviewed, head, reviewIgnore, docsDelta) {
  return reviewed === head || (docsDelta && onlyDocsBetween(root, reviewed, head, reviewIgnore));
}

/** 从指定提交读取登记文件并重新逐条核对，工作区里的修订不能作为收口证据。 */
export function checkRegisterAt(root, head, riskRegister, record) {
  const result = git(root, ['show', head + ':' + riskRegister]);
  if (!result.ok) return ['最终提交缺少风险登记或无法读取：' + riskRegister + '（本地缺提交时请先 git fetch）'];
  return registerProblems(result.out, { pr: record.pr, failHead: record.failHead, round: record.closedRound, mediumIds: record.mediumIds, mediumIssues: record.mediumIssues });
}

/** 发现表“位置”一栏里的文件路径（去掉反引号、行号和“起”“等”这类后缀）；写的不是路径时为 null。 */
function locationPath(location) {
  const first = String(location ?? '').replace(/`/g, '').trim().split(/[\s，,；;、]+/)[0] ?? '';
  const file = first.replace(/[:：#]\d.*$/, '').replace(/:L?\d+(?:[-–]\d+)?$/, '');
  return /[\\/.]/.test(file) && !/^https?:/i.test(file) ? file.replace(/\\/g, '/') : null;
}

/**
 * 收口时“已修”的可核对证据：被判不通过的提交到最终提交之间要有风险登记之外的改动，
 * 并且每条中级发现的“位置”写的是当时存在的文件时，这个文件要在改动里。写的不是文件的（跨文件、整体）不机械核对，
 * 放进 notes 由主对话核对。只改风险登记、或问题所在的文件根本没动，都不能当成修过。返回 { problems, notes }。
 */
export function fixEvidence(root, failHead, head, mediumIssues, riskRegister) {
  const problems = [];
  const notes = [];
  const diff = diffNames(root, [failHead, head]);
  if (!diff.ok) return { problems: ['算不出被审提交到最终提交之间改了哪些文件（本地缺提交时请先 git fetch）'], notes };
  const changed = new Set(diff.files);
  if (![...changed].some((f) => f !== riskRegister)) problems.push('被审提交之后只改了风险登记，没有修复改动');
  for (const issue of mediumIssues ?? []) {
    const file = locationPath(issue.location);
    if (!file || !git(root, ['cat-file', '-e', `${failHead}:${file}`]).ok) {
      if (issue.location !== null) notes.push(`中级 ${issue.id} 的位置“${issue.location}”不是被审提交里的文件，修复情况需主对话核对`);
      continue;
    }
    if (!changed.has(file)) problems.push(`中级 ${issue.id} 所在的文件 ${file} 在修复提交里没有改动，不能登记为已修`);
  }
  return { problems, notes };
}

/** 收口前提里与提交历史有关的部分（登记 close 与合并入口共用）：两种审查在最新一轮内容上都已登记，修复有改动证据。 */
export function closeEvidence(root, history, record, riskRegister) {
  const missing = roundMissing(history, ROUND_KEYS.pr.of, record.failHead);
  const problems = missing.length ? [`最新一轮被审提交 ${String(record.failHead).slice(0, 12)} 上还没有${missing.join('、')}的登记：两份意见收齐后才能收口`] : [];
  const fix = fixEvidence(root, record.failHead, record.headSha, record.mediumIssues, riskRegister);
  return { problems: [...problems, ...fix.problems], notes: fix.notes };
}

/** 收口开关开启时核对已登记的修复提交及其之后的文档改动，过期记录交回普通双审。 */
export function closeClearance(root, no, head, config) {
  if (config.roundClosure !== 'fix-and-record') return null;
  const rec = readPrRecord(root, no, 'close');
  if (rec?.kind !== 'close' || rec.verdict !== 'close' || rec.pr !== no || !rec.headSha || !rec.failHead ||
      !Number.isInteger(rec.closedRound) || !Array.isArray(rec.mediumIds) || rec.riskRegister !== config.riskRegister) return null;
  if (!freshness(root, rec.headSha, head, config.reviewIgnore, true)) return null;
  if (rec.headSha !== head && !git(root, ['merge-base', '--is-ancestor', rec.headSha, head]).ok) return null;
  // 收口之后如果又登记了不通过，需要根据新的发现重新处置。
  const history = readLog(prLogFile(root, no));
  const at = history.findLastIndex((e) => e.kind === 'close' && e.at === rec.at && e.headSha === rec.headSha);
  if (at < 0 || history.slice(at + 1).some((e) => e.verdict === 'fail')) return null;
  // 若并行的第二份 fail 在 close 写日志之前刚登记，旧快照也不能覆盖新增的发现。
  const keyOf = ROUND_KEYS.pr.of;
  const state = roundState(history, { keyOf, limit: config.maxReviewRounds, closure: config.roundClosure });
  const latest = lastFailRound(history, keyOf);
  if (state.phase !== 'close-only' || state.counted !== rec.closedRound || latest.failHead !== rec.failHead ||
      JSON.stringify(latest.mediumIds) !== JSON.stringify(rec.mediumIds) ||
      JSON.stringify(latest.mediumIssues) !== JSON.stringify(rec.mediumIssues ?? latest.mediumIssues)) return null;
  // 在最终提交上重新核对：风险登记、两份意见收齐、修复改动证据（收口之后只改文档的提交也要满足）
  const evidence = closeEvidence(root, history, { ...rec, headSha: head }, config.riskRegister);
  const problems = [...checkRegisterAt(root, head, config.riskRegister, rec), ...evidence.problems];
  return { problems, notes: problems.length ? [] : ['按收口放行（已修、未再复审）', ...evidence.notes] };
}
