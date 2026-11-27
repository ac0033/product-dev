// PR 复审的轮次、登记资格和收口证据。所有判定只使用调用方提供的事实。
import { isRepoPath } from './config.mjs';
import { createHash } from 'node:crypto';
import { canonicalJson, hasContent, isSerious } from './review-data.mjs';

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
  // 停下信号（无法彻底解决、标为系统性）看这一轮每份有效报告，通过的报告也算；数量比较只数不通过报告里的高、中级
  const flagged = [...new Set([...Object.values(failures), ...Object.values(records)])].flatMap((entry) => entry.findings ?? []);
  const counts = { high: 0, medium: 0 };
  const systemicWhy = [];
  for (const finding of findings) {
    if (isSerious(finding)) {
      counts[finding.severity]++;
      if (finding.prior) systemicWhy.push(finding.id + ' 与上轮 ' + finding.prior + ' 是同一问题');
    }
  }
  for (const finding of flagged) if (finding.systemic) systemicWhy.push(finding.id + ' 被标为系统性问题');
  if (previous) {
    if (previous.counts.high === 0 && counts.high > 0) systemicWhy.push('上轮没有高级问题，本轮出现了高级问题');
    for (const [key, label] of [['high', '高级'], ['medium', '中级']]) {
      if (counts[key] > previous.counts[key]) systemicWhy.push(label + '问题比上轮多');
    }
  }
  return { head, index, records, failures, missingKinds, collected: !missingKinds.length, counts, high: counts.high > 0,
    unresolvable: flagged.some((f) => f.unresolvable), systemic: systemicWhy.length > 0, systemicWhy };
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

/**
 * 按首次 fail 的登记顺序计算每轮状态，只用按规则登记的记录（越权登记见下）。第 1 到 N 轮（N = limit）各用该提交上的全部登记。
 * 最后一轮（第 N+1 轮）只用一种口径：第 N 轮收齐之后、最后一轮提交（finalHead）上的有效登记（pass、fail、accept、一致性审 defer）；
 * 收齐之前的任何登记都不计入最后一轮的收齐、风险信号和收口证据。finalHead 是收齐之后第一条落在别的提交上的 pass 或 fail。
 */
export function roundState({ entries, limit, closure, required = ['code', 'consistency'] }) {
  // 越权登记（不带用户决定就会被拒、经用户决定才登记的）只留作追溯，轮次计算一律不计。0.10.1 起登记时写明 outOfBand；
  // 更早的记录没有这个字段：带用户决定的按当时已有的记录重放一次准入，不带用户决定就会被拒的同样算越权
  const valid = (e) => required.includes(e.kind) && (counted(e) || e.verdict === 'accept' || (e.kind === 'consistency' && e.verdict === 'defer'));
  const kept = [];
  for (const e of entries) {
    if (!valid(e) || e.outOfBand === true) continue;
    if (e.outOfBand === undefined && e.verdict !== 'accept' && hasContent(e.userDecision)) {
      const then = computeRounds({ history: kept, limit, closure, required });
      if (admitRegistration(then, { verdict: e.verdict, kind: e.kind, head: e.headSha, userDecision: null })) continue;
    }
    kept.push(e);
  }
  return computeRounds({ history: kept, limit, closure, required });
}

/** roundState 的计算部分：history 已去掉越权登记和无关记录。 */
function computeRounds({ history, limit, closure, required }) {
  const byHead = new Map();
  const firstFail = new Map();
  for (const [i, entry] of history.entries()) {
    if (!byHead.has(entry.headSha)) byHead.set(entry.headSha, []);
    byHead.get(entry.headSha).push(entry);
    if (entry.verdict === 'fail' && !firstFail.has(entry.headSha)) firstFail.set(entry.headSha, i);
  }
  const failHeads = [...firstFail.keys()];
  const rounds = [];
  for (const head of failHeads.slice(0, limit)) rounds.push(summarize(head, rounds.length + 1, byHead.get(head), required, rounds.at(-1)));
  const lastAllowed = rounds[limit - 1];
  let finalHead = null;
  let finalKinds = [];
  let finalEntries = [];
  // 超出允许轮次的不通过：默认是第 N 轮之后的全部；开放最后一轮时只算第 N 轮收齐之后的（与最后一轮同一个时间截点）
  let extraFrom = 0;
  if (lastAllowed?.collected && lastAllowed.high && !lastAllowed.unresolvable && !lastAllowed.systemic) {
    // 收齐位置以第 N 轮提交首次不通过为下界（之前在该提交上的登记照算进收齐）
    const start = firstFail.get(lastAllowed.head);
    const seen = new Set(history.slice(0, start).filter((e) => e.headSha === lastAllowed.head).map((e) => e.kind));
    let collectedAt = -1;
    for (let i = start; i < history.length && collectedAt < 0; i++) {
      if (history[i].headSha === lastAllowed.head) seen.add(history[i].kind);
      if (required.every((k) => seen.has(k))) collectedAt = i;
    }
    extraFrom = collectedAt + 1;
    const after = history.slice(extraFrom);
    finalHead = after.find((e) => e.headSha !== lastAllowed.head && counted(e))?.headSha ?? null;
    finalEntries = finalHead ? after.filter((e) => e.headSha === finalHead) : [];
    finalKinds = [...new Set(finalEntries.map((e) => e.kind))];
    if (finalEntries.some((e) => e.verdict === 'fail')) rounds.push(summarize(finalHead, limit + 1, finalEntries, required, lastAllowed));
  }
  // 超出允许轮次的提交：收齐之前（经用户决定）在别的提交上的不通过只留作追溯，不占轮次；最后一轮提交另算
  const allowed = new Set(rounds.map((r) => r.head));
  const extraHeads = [...new Set(history.slice(extraFrom).filter((e) => e.verdict === 'fail' && !allowed.has(e.headSha) && e.headSha !== finalHead).map((e) => e.headSha))];
  for (const head of extraHeads) {
    const own = history.slice(extraFrom).filter((e) => e.headSha === head);
    rounds.push(summarize(head, rounds.length + 1, own, required, rounds.at(-1)));
  }
  const state = { closure, limit, rounds, latest: rounds.at(-1) ?? null, finalHead, finalKinds };
  const [phase, reasons] = classify(state);
  return { ...state, phase, reasons };
}

/** 对 head 的复审是否算最后一轮：final-next 尚未绑定时的新提交，或已绑定的最后一轮提交（不论阶段）。登记准入另由 admitRegistration 判定。 */
export function finalRoundTarget(state, head) {
  if (!state?.latest || state.phase === 'off') return false;
  if (state.finalHead) return head === state.finalHead;
  return state.phase === 'final-next' && head !== state.latest.head;
}

/** 核对本次登记，放行返回 null，否则返回包含下一步的原因。 */
export function admitRegistration(state, { verdict, kind, head, userDecision }) {
  if (verdict === 'accept' || hasContent(userDecision)) return null;
  const { latest, phase, finalHead } = state;
  // 收齐前只认该提交上缺的那种审查；一致性审的延期也算登记（A13）
  if (phase === 'collecting' && !(head === latest.head && latest.missingKinds.includes(kind))) {
    return '第 ' + latest.index + ' 轮还没收齐：先在 ' + latest.head.slice(0, 12) + ' 上登记 ' + latest.missingKinds.join('、') + '；收齐后才判定下一步';
  }
  if (verdict === 'defer') return null;
  // 收口要求该轮每种审查都完整覆盖：只是部分覆盖的那种，可以在失败提交上补一份同种复审（补齐覆盖），不算加轮
  if (phase === 'close-only' && head === latest.head && latest.records[kind] && latest.records[kind].verdict !== 'defer' && latest.records[kind].coverage !== 'full') return null;
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

// 风险登记是 git 跟踪的文件，会随 PR 推送：只存编号、提交、指纹和作者核对后写的可共享摘要。
// 发现的位置、问题、理由、建议改法原文只留在本地的复审数据副本里（本地复审者看得到不外发的内容），close 按指纹核对。
const textKeys = ['pr', 'commit', 'kind', 'id', 'severity', 'status', 'dataSha', 'findingSha', 'summary'];
const keys = [...textKeys, 'round', 'fixedIn'];
// 0.10.0 的旧格式逐字写了原文：仍能解析（legacy），不能作收口证据，重跑 risks 时改写成新格式
const legacyText = ['pr', 'commit', 'kind', 'id', 'severity', 'location', 'problem', 'reason', 'fix', 'status'];
const legacyKeys = [...legacyText, 'round', 'fixedIn'];
export const MAX_SUMMARY_CHARS = 300;
// 原始定位仅用于核对“已修”的证据和修复差异白名单，不属于写入 JSON Lines 的登记字段。
const findingFiles = Symbol('发现定位文件');

/** 一条完整发现的指纹：规范 JSON 的 sha256。 */
export function findingFingerprint(finding) {
  return createHash('sha256').update(canonicalJson(finding)).digest('hex');
}

/** 可共享摘要的指纹（本机申报里记它，close 与合并核对提交里的摘要没被改过）。 */
export function summaryFingerprint(summary) {
  return createHash('sha256').update(String(summary)).digest('hex');
}

/** 可共享摘要的格式问题，合格返回 null。是否可以共享由作者核对，这里只查形式。 */
export function summaryProblem(summary) {
  if (typeof summary !== 'string' || !summary.trim()) return '缺少可共享摘要';
  if ([...summary].length > MAX_SUMMARY_CHARS) return '可共享摘要超过 ' + MAX_SUMMARY_CHARS + ' 字';
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(summary)) return '可共享摘要含换行、行分隔符、段落分隔符或控制、格式字符';
  return null;
}

/** 从核对过指纹的完整发现生成中级风险条目（摘要待作者填写）。同号的不同审查各保留一条。 */
export function expectedRiskEntries({ pr, round, failHead, failures }) {
  const entries = [];
  for (const { kind, findings, dataSha } of failures) {
    for (const finding of findings) {
      if (finding.severity !== 'medium') continue;
      const entry = { pr, commit: failHead, round, kind, id: finding.id, severity: finding.severity, status: STATUS, fixedIn: [],
        dataSha: dataSha ?? null, findingSha: findingFingerprint(finding), summary: null };
      Object.defineProperty(entry, findingFiles, { value: finding.files ?? [] });
      entries.push(entry);
    }
  }
  return entries;
}

const exactKeys = (v, list) => Object.keys(v).length === list.length && list.every((k) => Object.hasOwn(v, k));
const validRound = (v) => Number.isInteger(v.round) && v.round >= 1 && Array.isArray(v.fixedIn) && v.fixedIn.every(isRepoPath) && new Set(v.fixedIn).size === v.fixedIn.length;

/**
 * 显示用的路径：控制字符、格式字符、行分隔符和段落分隔符（如 U+2028、U+2029）及反斜杠转义成 \t、\n、\u2028 这样的可见写法，
 * 一条路径在终端和报告里只占一行，也不会被误读成另一条诊断。所有面向用户的收口路径都经它。
 */
export function displayPath(file) {
  const named = { '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' };
  return String(file).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\\]/gu, (c) => named[c] ?? '\\u' + c.codePointAt(0).toString(16).padStart(4, '0'));
}
const shown = (files) => files.map(displayPath).join('、');

/** 解析风险登记的全部非空行，分别返回有效条目（旧格式带 legacy: true）与含物理行号的错误。 */
export function parseRiskRegister(text) {
  const entries = [];
  const problems = [];
  for (const [i, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('须为 JSON 对象');
      if (exactKeys(v, legacyKeys)) {
        if (!legacyText.every((k) => typeof v[k] === 'string') || !validRound(v)) throw new Error('字段类型、轮次或实际改在的路径不合法');
        entries.push({ ...v, legacy: true });
        continue;
      }
      if (!exactKeys(v, keys)) throw new Error('字段缺失或有额外字段');
      if (!textKeys.every((k) => typeof v[k] === 'string') || !validRound(v)) throw new Error('字段类型、轮次或实际改在的路径不合法');
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
  // 修复差异只放行白名单：本轮中级发现的定位文件、申报的实际修复路径、风险登记，以及 exempt 认定的测试和文档
  const allowed = new Set([registerPath]);
  for (const e of expected) {
    const label = e.kind + ' ' + e.id + '：';
    const same = byKey.get(riskKey(e)) ?? [];
    const matches = same.filter((v) => !v.legacy && v.round === e.round);
    for (const f of e[findingFiles] ?? []) allowed.add(f);
    // 同一条发现还留着旧格式行（逐字写了复审原文）时不收口：新旧并存说明原文还在要推送的文件里
    if (same.some((v) => v.legacy)) {
      problems.push(label + '风险登记里还有这条发现的旧格式行（0.10.0，逐字写了复审原文）：重新运行 review.mjs risks 改写成新格式并提交（已推送过的历史里仍有原文，按项目规则另行处理）');
      continue;
    }
    if (matches.length !== 1) {
      problems.push(label + (matches.length ? '风险登记条目重复' : '缺少风险登记条目'));
      continue;
    }
    const [actual] = matches;
    // 申报的修复路径只认本机登记（risks 在 PR 锁内留下、PR 改不到的那份）：提交里的 fixedIn 必须与它一致
    const declared = facts.declaredFixedIn?.get(riskKey(e));
    const sameSet = (a, b) => { const x = new Set(a); const y = new Set(b); return x.size === a.length && y.size === b.length && x.size === y.size && [...x].every((f) => y.has(f)); };
    if (!declared || declared.findingSha !== e.findingSha) {
      problems.push(label + '本机没有 risks 对这条发现的登记（或登记针对的不是同一条发现）：在本机运行 review.mjs risks 生成风险登记，不要手写或改写');
      continue;
    }
    if (!sameSet(actual.fixedIn, declared.fixedIn)) {
      problems.push(label + '提交里的实际改在（' + (shown(actual.fixedIn) || '无') + '）与本机 risks 登记的申报（' + (shown(declared.fixedIn) || '无') + '）不一致：修复路径只能经 review.mjs risks --fixed-in 申报');
      continue;
    }
    for (const f of declared.fixedIn) allowed.add(f);
    for (const k of ['severity', 'status', 'dataSha', 'findingSha']) {
      if (actual[k] !== e[k]) problems.push(label + k + ' 与预期登记内容不一致');
    }
    const bad = summaryProblem(actual.summary);
    if (bad) problems.push(label + bad);
    // 摘要只认 risks 核对后写下的那份：本机申报记着它的指纹，提交里改过的摘要不认
    else if (declared.summarySha !== summaryFingerprint(actual.summary)) problems.push(label + '可共享摘要与本机 risks 登记的不一致：摘要只能经 review.mjs risks --shared-summary 写');
    const files = e[findingFiles] ?? [];
    // “已修”的证据用本机申报（可信的那份），不用提交里的数组
    if (!files.some((f) => changed.has(f)) && !(declared.fixedIn.length && declared.fixedIn.every((f) => changed.has(f)))) {
      problems.push(label + '定位文件 ' + (shown(files) || '（无）') + ' 和实际改在 ' + (shown(declared.fixedIn) || '（无）') + ' 都不在修复差异里');
    }
  }
  const exempt = typeof facts.exempt === 'function' ? facts.exempt : () => false;
  const outside = fixDiff.filter((f) => !allowed.has(f) && !exempt(f));
  if (outside.length) {
    problems.push('修复差异含白名单外的文件：' + shown(outside) + '。收口只放行本轮中级发现的定位文件、--fixed-in 申报的路径、测试、文档和风险登记；' +
      '这些改动没有经过复审，请撤到另一个 PR，或向用户说明后由用户决定对最终提交做普通双审（登记带 --user-decision）');
  }
  return problems;
}
