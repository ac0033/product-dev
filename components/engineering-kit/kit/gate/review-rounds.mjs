// PR 复审的轮次、登记资格和收口证据。所有判定只使用调用方提供的事实。
import { isRepoPath } from './config.mjs';
import { hasContent, isSerious } from './review-data.mjs';

export const FINAL_ROUND_TEXT = '这是最后一轮复审，务必全面、彻底；中高风险逐条列清理由和彻底解决办法；确实无法彻底解决的，unresolvable 写 true 并说明原因。';
const STATUS = '已修、未再复审';
const counted = (entry) => entry.verdict === 'pass' || entry.verdict === 'fail';

function summarize(head, index, history, required, previous) {
  const records = {};
  const failures = {};
  for (const entry of history) {
    records[entry.kind] = entry;
    if (entry.verdict === 'fail') failures[entry.kind] = entry;
  }
  const missingKinds = required.filter((kind) => !records[kind]);
  const findings = Object.values(failures).flatMap((entry) => entry.findings ?? []);
  const counts = { high: 0, medium: 0 };
  const systemicWhy = [];
  for (const finding of findings) {
    if (isSerious(finding)) {
      counts[finding.severity]++;
      if (finding.prior) systemicWhy.push(finding.id + ' 与上轮 ' + finding.prior + ' 是同一问题');
    }
    if (finding.systemic) systemicWhy.push(finding.id + ' 被标为系统性问题');
  }
  if (previous) {
    if (previous.counts.high === 0 && counts.high > 0) systemicWhy.push('上轮没有高级问题，本轮出现了高级问题');
    for (const [key, label] of [['high', '高级'], ['medium', '中级']]) {
      if (counts[key] > previous.counts[key]) systemicWhy.push(label + '问题比上轮多');
    }
  }
  return { head, index, records, failures, missingKinds, collected: !missingKinds.length, counts, high: counts.high > 0,
    unresolvable: findings.some((f) => f.unresolvable), systemic: systemicWhy.length > 0, systemicWhy };
}

function classify({ closure, limit, rounds, latest, finalHead }) {
  if (closure === 'off') return ['off', []];
  if (!latest) return ['open', []];
  if (!latest.collected) return ['collecting', ['缺少 ' + latest.missingKinds.join('、') + ' 登记']];
  const reasons = [...latest.systemicWhy];
  if (latest.unresolvable) reasons.push('发现无法彻底解决的问题');
  if (reasons.length) return ['stop', reasons];
  if (rounds.length < limit) return ['open', []];
  if (rounds.length === limit) return [latest.high ? 'final-next' : 'close-only', []];
  if (rounds.length === limit + 1 && latest.head === finalHead) {
    return latest.high ? ['stop', ['最后一轮仍有高级问题']] : ['close-only', []];
  }
  return ['stop', ['本轮超出允许的最后一轮']];
}

/** 按首次 fail 的登记顺序计算每轮状态，同时保留最后一轮提交上已经登记 pass、fail 的种类。 */
export function roundState({ entries, limit, closure, required = ['code', 'consistency'] }) {
  const history = entries.filter((e) => required.includes(e.kind) && (counted(e) || e.verdict === 'accept' || (e.kind === 'consistency' && e.verdict === 'defer')));
  const byHead = new Map();
  const firstFail = new Map();
  for (const [i, entry] of history.entries()) {
    if (!byHead.has(entry.headSha)) byHead.set(entry.headSha, []);
    byHead.get(entry.headSha).push(entry);
    if (entry.verdict === 'fail' && !firstFail.has(entry.headSha)) firstFail.set(entry.headSha, i);
  }
  const rounds = [];
  for (const head of firstFail.keys()) rounds.push(summarize(head, rounds.length + 1, byHead.get(head), required, rounds.at(-1)));
  const lastAllowed = rounds[limit - 1];
  let finalHead = null;
  if (lastAllowed?.collected && lastAllowed.high && !lastAllowed.unresolvable && !lastAllowed.systemic) {
    finalHead = history.slice(firstFail.get(lastAllowed.head) + 1).find((e) => e.headSha !== lastAllowed.head && counted(e))?.headSha ?? null;
  }
  const state = { closure, limit, rounds, latest: rounds.at(-1) ?? null, finalHead,
    finalKinds: [...new Set((byHead.get(finalHead) ?? []).filter(counted).map((e) => e.kind))] };
  const [phase, reasons] = classify(state);
  return { ...state, phase, reasons };
}

/** 核对本次登记，放行返回 null，否则返回包含下一步的原因。 */
export function admitRegistration(state, { verdict, kind, head, userDecision }) {
  if (['accept', 'defer'].includes(verdict) || hasContent(userDecision)) return null;
  const { latest, phase, finalHead } = state;
  if (phase === 'collecting' && !(head === latest.head && latest.missingKinds.includes(kind))) {
    return '第 ' + latest.index + ' 轮还没收齐：先在 ' + latest.head.slice(0, 12) + ' 上登记 ' + latest.missingKinds.join('、') + '；收齐后才判定下一步';
  }
  if (phase === 'close-only') return '第 ' + latest.index + ' 轮只剩中、低级：修完全部中级，用 review.mjs risks 写进风险登记并提交后，用 review.mjs close 登记，不再加轮';
  if (phase === 'final-next') {
    if (finalHead ? head === finalHead && !state.finalKinds.includes(kind) : head !== latest.head) return null;
    return '最后一轮只认' + (finalHead ? '提交 ' + finalHead.slice(0, 12) + ' 上未登记的审查' : '修复后的新提交') + '；其他登记要用户决定（--user-decision）';
  }
  if (phase === 'stop') return state.reasons.join('、') + '：停下向用户汇报，建议单开对话专项处理；用户同意继续的带 --user-decision 登记';
  return null;
}

/** 登记完成后提示下一步；其余阶段没有额外提示。 */
export function nextHint(state) {
  if (state.phase === 'final-next' && !state.finalHead) return '下一轮是最后一轮：修后复核的任务书写明最后一轮，中高风险逐条写理由与彻底解决办法';
  if (state.phase === 'close-only') return '只剩中、低级：修完中级、写风险登记后 close';
  if (state.phase === 'stop') return '停下向用户汇报：' + state.reasons.join('、') + '，建议专项处理';
  return null;
}

const textKeys = ['pr', 'commit', 'kind', 'id', 'severity', 'location', 'problem', 'reason', 'fix', 'status'];
const keys = [...textKeys, 'round', 'fixedIn'];
// 原始定位仅用于核对“已修”的证据，不属于写入 JSON Lines 的登记字段。
const findingFiles = Symbol('发现定位文件');

/** 从核对过指纹的完整发现生成中级风险条目。同号的不同审查各保留一条。 */
export function expectedRiskEntries({ pr, round, failHead, failures }) {
  const entries = [];
  for (const { kind, findings } of failures) {
    for (const { id, severity, location, problem, reason, fix, files } of findings) {
      if (severity !== 'medium') continue;
      const entry = { pr, commit: failHead, round, kind, id, severity, location, problem, reason, fix, status: STATUS, fixedIn: [] };
      Object.defineProperty(entry, findingFiles, { value: files ?? [] });
      entries.push(entry);
    }
  }
  return entries;
}

/** 解析风险登记的全部非空行，分别返回有效条目与含物理行号的错误。 */
export function parseRiskRegister(text) {
  const entries = [];
  const problems = [];
  for (const [i, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('须为 JSON 对象');
      if (Object.keys(v).some((k) => !keys.includes(k)) || keys.some((k) => !Object.hasOwn(v, k))) throw new Error('字段缺失或有额外字段');
      if (!textKeys.every((k) => typeof v[k] === 'string') || !Number.isInteger(v.round) || v.round < 1 ||
          !Array.isArray(v.fixedIn) || !v.fixedIn.every(isRepoPath)) throw new Error('字段类型、轮次或实际改在的路径不合法');
      entries.push(v);
    } catch (e) {
      problems.push('风险登记第 ' + (i + 1) + ' 行：' + (e instanceof SyntaxError ? '不是合法 JSON' : e.message));
    }
  }
  return { entries, problems };
}

/** 同一 PR、失败提交和审查种类下的同号发现，重新生成时覆盖原条目。 */
export function riskKey(e) {
  return JSON.stringify([e.pr, e.commit, e.kind, e.id]);
}

/** risks、close 共用的阶段与配置前提。 */
export function riskPhaseProblems({ closure, flow, state }) {
  const problems = [];
  if (closure !== 'fix-and-record') problems.push('请启用 roundClosure: fix-and-record');
  if (flow !== 'pr') problems.push('轮次收口要求 pr 流程');
  if (state.phase !== 'close-only') problems.push('当前阶段 ' + state.phase + '，收口要求 close-only。' + state.reasons.join('、'));
  return problems;
}

/** 对最终提交的 PR、CI、风险登记与修复差异逐条核对，返回所有未满足的前提。 */
export function closureProblems(facts) {
  const { prOpen, ciProblems, head, failHead, headIsDescendant, register, expected, fixDiff, registerPath } = facts;
  const problems = riskPhaseProblems(facts);
  if (!prOpen) problems.push('PR 不是打开状态');
  problems.push(...ciProblems);
  if (!failHead || head === failHead) problems.push('最终提交必须不同于最新失败提交');
  if (!headIsDescendant) problems.push('最终提交不是最新失败提交的后代');
  if (facts.closeRecord !== undefined) {
    const close = facts.closeRecord;
    if (!close || close.kind !== 'close' || close.verdict !== 'close') problems.push('收口记录损坏');
    else {
      if (close.failHead !== failHead) problems.push('收口后最新失败提交已变化');
      if (close.headSha !== head && !facts.docsSinceClose) problems.push('收口后含非文档改动或无法核对提交差异');
    }
  }
  if (!register) problems.push('最终提交上缺少风险登记 ' + registerPath);
  else problems.push(...register.problems);
  const changed = new Set(fixDiff);
  changed.delete(registerPath);
  const byKey = new Map();
  for (const e of register?.entries ?? []) {
    const key = riskKey(e);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(e);
  }
  for (const e of expected) {
    const label = e.kind + ' ' + e.id + '：';
    const matches = (byKey.get(riskKey(e)) ?? []).filter((v) => v.round === e.round);
    if (matches.length !== 1) {
      problems.push(label + (matches.length ? '风险登记条目重复' : '缺少风险登记条目'));
      continue;
    }
    const [actual] = matches;
    for (const k of ['severity', 'location', 'problem', 'reason', 'fix', 'status']) {
      if (actual[k] !== e[k]) problems.push(label + k + ' 与预期登记内容不一致');
    }
    const files = e[findingFiles] ?? [];
    if (!files.some((f) => changed.has(f)) && !(actual.fixedIn.length && actual.fixedIn.every((f) => changed.has(f)))) {
      problems.push(label + '定位文件 ' + (files.join('、') || '（无）') + ' 和实际改在 ' + (actual.fixedIn.join('、') || '（无）') + ' 都不在修复差异里');
    }
  }
  return problems;
}
