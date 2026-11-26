// 复审轮次：按被审内容统计失败轮数，判定是否需要用户决定。
/** 1–10 的中文数字（拦截提示里写“已审三轮”）；更大的写阿拉伯数字。 */
function cnNumber(n) {
  return n >= 1 && n <= 10 ? '一二三四五六七八九十'[n - 1] : String(n);
}

/**
 * 轮次的键：一轮＝登记过不通过的一份被审内容。pr 流程是 PR 的最终提交（headSha）；pre-push 流程是登记时的工作区内容，
 * 用记录里的树哈希加文档内容哈希（treeHash:docHash）——不用 HEAD 提交号：修复留在工作区不提交时 HEAD 不变；reset 回已经计入的
 * 旧提交时，HEAD 就是那个已计入的提交。两种情况按提交号计，新内容都会被当成已计入的那一轮而放行，上限失效。
 * 只用树哈希又分不出只改文档的各轮（树哈希不含 reviewIgnore 之内的文档）。缺这些字段的旧记录各算一个。
 */
export const ROUND_KEYS = {
  pr: { unit: '按提交计', of: (e, i) => e.headSha || `无提交号#${i}` },
  'pre-push': { unit: '按被审内容计', of: (e, i) => (e.treeHash && e.docHash ? `${e.treeHash}:${e.docHash}` : `无内容哈希#${i}`) },
};

/** 已计入轮次的键（登记过 fail 的被审内容），按第一次登记 fail 的先后排列；同一份内容上两种审查都 fail 只算一个。 */
export function failKeys(entries, keyOf) {
  const keys = [];
  entries.forEach((e, i) => {
    if (e.verdict !== 'fail') return;
    const key = keyOf(e, i);
    if (!keys.includes(key)) keys.push(key);
  });
  return keys;
}

/**
 * 轮次核对：prior 是同一 PR 或同一分支此前的登记，cur 是本次登记的 { key, kind }。返回拒绝信息，放行时返回 null。
 * - accept、defer 不计轮次、不受拦截；上限未满时任何 pass、fail（包括同一内容同一 kind 重新登记）都放行。
 * - 已有 limit 份不同内容登记过 fail 之后，pass、fail 须带 userDecision，只有一个例外：这份内容已经计入轮次，
 *   而本次的 kind 在这份内容上还没登记过 pass 或 fail——并行双审的第二份登记不能被它自己这一轮拦住。
 * 例（上限 3）：第 3 份内容上代码复审 fail 已登记，同一内容的一致性审第一次登记（fail 或 pass）照常；同一内容再登记代码复审、
 * 或一致性审第二次登记，都要 userDecision；第 4 份内容上的任何 pass、fail 都要 userDecision；改回已计入的旧内容（例如 reset）时，同一 kind 重登同样要。
 */
export function roundBlock(prior, verdict, { limit, userDecision, scope, cur, keyOf, closure = 'off' }) {
  if (verdict !== 'pass' && verdict !== 'fail') return null;
  const counted = failKeys(prior, keyOf);
  if (counted.length < limit || (userDecision && userDecision.trim())) return null;
  const sameKindDone = prior.some((e, i) => keyOf(e, i) === cur.key && e.kind === cur.kind && (e.verdict === 'pass' || e.verdict === 'fail'));
  if (counted.includes(cur.key) && !sameKindDone) return null;
  if (closure === 'fix-and-record') {
    const { phase } = roundState(prior, { keyOf, limit, closure });
    if (phase === 'final-next' && !counted.includes(cur.key)) return null;
    if (phase === 'close-only') return '已到收口轮次，修完中级问题并写入风险登记后，用 review.mjs close 登记收口；继续复审须带 --user-decision';
    if (phase === 'stop') return '停下向用户汇报，建议单开对话专项处理；继续复审须带 --user-decision';
  }
  return (
    `已审${cnNumber(limit)}轮仍需再审：向用户说明剩余问题、原因和已做处置，由用户决定；用户同意继续的，带 --user-decision "<用户的决定及出处>" 重新登记` +
    `（${scope}已有 ${counted.length} 份不同的被审内容登记过不通过，上限 ${limit} 轮，见 modules.review.maxReviewRounds）`
  );
}

/**
 * 登记成功后的轮次统计行：第几轮（accept、defer 不计轮次）、累计登记次数、涉及的不同提交数。entries 含本次（在最后），key 是本次的键。
 * 本次的内容已计入时就是它那一轮；还没计入（本次是 pass）时是下一轮。
 */
export function roundLine(entries, verdict, limit, scope, key, keys) {
  const counted = failKeys(entries, keys.of);
  const commits = new Set(entries.map((e) => e.headSha).filter(Boolean)).size;
  const tail = `${scope}累计登记 ${entries.length} 次，涉及 ${commits} 个不同提交`;
  if (verdict === 'pass' || verdict === 'fail') {
    const at = counted.indexOf(key);
    const round = at >= 0 ? at + 1 : counted.length + 1;
    return `复审轮次：第 ${round} 轮（${keys.unit}，上限 ${limit} 轮），${tail}`;
  }
  return `复审轮次：本次${verdict === 'accept' ? '接受风险' : '延期'}不计轮次；已审 ${counted.length} 轮（${keys.unit}，上限 ${limit} 轮），${tail}`;
}

/** 按首次 fail 的顺序分组；同一内容上的双审共同决定能否收口。 */
function failRounds(entries, keyOf) {
  const groups = new Map();
  entries.forEach((entry, i) => {
    if (entry.verdict !== 'fail') return;
    const key = keyOf(entry, i);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  });
  return [...groups.values()];
}

/** 从 fail 历史取出最新一轮被审提交及其全部中级编号，保留双审的同名编号。 */
export function lastFailRound(entries, keyOf) {
  const keys = failKeys(entries, keyOf);
  const failHead = keys.at(-1);
  const latest = entries.filter((e, i) => e.verdict === 'fail' && keyOf(e, i) === failHead);
  const mediumIds = latest.flatMap((e) => e.findings?.mediumIds ?? []);
  return { failHead, latest, mediumIds };
}

/** 任一份报告无法解析或明确写了无法彻底解决，都不能走自动收口。 */
function phaseAfter(group, allowFinal) {
  if (group.some(({ findings: f }) => !f?.parsed || f.unresolvable)) return 'stop';
  if (group.some(({ findings: f }) => f.high > 0)) return allowFinal ? 'final-next' : 'stop';
  return 'close-only';
}

/** 按上限及历次 fail 登记给出当前阶段和已计轮数；旧记录缺少发现统计时保守停止。 */
export function roundState(entries, { keyOf, limit, closure }) {
  const groups = failRounds(entries, keyOf);
  const counted = groups.length;
  let phase = 'open';
  if (counted >= limit) {
    phase = 'stop';
    if (closure === 'fix-and-record' && counted <= limit + 1) {
      if (counted === limit) phase = phaseAfter(groups.at(-1), true);
      else {
        // 只用进入最后一轮之前已知的报告判断当时是否允许加轮。
        const firstFinal = entries.indexOf(groups.at(-1)[0]);
        const before = failRounds(entries.slice(0, firstFinal), keyOf);
        if (phaseAfter(before.at(-1), true) === 'final-next') phase = phaseAfter(groups.at(-1), false);
      }
    }
  }
  return { phase, counted };
}

/** 比较最近两轮中高风险编号、最高级别和总数，返回需要向用户汇报的收敛提示。 */
export function trendWarnings(entries, keyOf) {
  const pair = failRounds(entries, keyOf).slice(-2);
  if (pair.length !== 2 || pair.some((group) => group.some((e) => !e.findings?.parsed))) return [];
  const [previous, current] = pair.map((group) => {
    const ids = new Set();
    const highIds = new Set();
    let total = 0;
    for (const { findings } of group) {
      for (const id of [...findings.highIds, ...findings.mediumIds]) ids.add(id);
      for (const id of findings.highIds) highIds.add(id);
      total += findings.high + findings.medium;
    }
    return { ids, highIds, total };
  });
  const warnings = [];
  const repeated = [...current.ids].filter((id) => previous.ids.has(id));
  if (repeated.length) warnings.push('同一问题在两轮重复出现：' + repeated.join('、'));
  const raised = [...current.highIds].filter((id) => previous.ids.has(id) && !previous.highIds.has(id));
  if (raised.length) warnings.push('以下问题从中级升至高级：' + raised.join('、'));
  else if (current.highIds.size && !previous.highIds.size) warnings.push('发现的最高级别升至高级');
  if (current.total > previous.total) warnings.push('中高级发现数量增加：' + previous.total + ' → ' + current.total);
  return warnings;
}
