// 复审记录：独立复审（代码复审 code 或一致性审 consistency）后在这里登记。业务含义：复审必须由不共享作者上下文的独立复审者完成——宿主子代理或外部执行器（external-review.mjs，登记名 external:<执行器>），且在允许名单内；
// 判定策略（复审流程、必需检查名、复审者名单、必需的节、最少字数、结论关键词、复审轮次上限）取基准提交上的配置，被审分支改了不算数（lib.mjs 的 loadConfig）。
// 报告要有实质内容：必需的几节（modules.review.reviewSections，默认范围、发现、作者的验证，见 missingSections）齐全且各有内容，
// 并且有一处明确的结论（写法见 reportVerdict）：登记 pass 要求结论是通过，登记 fail 要求结论是不通过，
// 找不到明确结论、前后矛盾或与登记不符时拒绝。四种登记：
//   pass / fail   复审结论。
//   defer         一致性审延期（只限 consistency），须写理由。
//   accept        用户接受风险：报告结论是不通过，但用户已知情并决定接受其中的问题、不再修改；须带 --user-decision 写明用户的决定及出处。
// 复审轮次：一轮＝同一 PR（pr 流程）或同一分支（pre-push 流程）上登记过 fail 的一份被审内容：pr 流程是一个最终提交，
//   pre-push 流程是一份工作区内容（树哈希加文档内容哈希，见 ROUND_KEYS）；同一份内容上两种 kind 都 fail 只算一轮。
//   已有 maxReviewRounds（默认 3）份不同内容登记过 fail 后，再登记 pass 或 fail 须向用户说明后带 --user-decision；
//   唯一例外是在已计入的内容上首次登记另一种 kind（见 roundBlock）。accept 与 defer 不计轮次、不受拦截。每次登记成功的输出末尾给出轮次统计。
// 按项目的复审流程（modules.gate.reviewFlow）分两种：
//   pre-push：推送前复审，绑定当前代码树哈希和基准提交（基线）；登记 pass、fail、accept 前必须已有与当前代码、当前基线一致的通过测试记录
//       （全量或按影响范围的都行）。闸门范围与 gate.mjs、verify.mjs 同一口径（lib.mjs 的 gateScope）。
//       代码树哈希不含文档（reviewIgnore），只改规则文本这类改动每一轮的树哈希都相同，所以登记另外写明分支、HEAD 提交号、
//       文档内容哈希和登记时未提交的文件数，用来把每次登记对应到具体的分支和提交；推送核对（verify.mjs）认树哈希与基线。
//       代码复审的最新一条写 review.json（推送核对读它）；一致性审写 review-consistency.json（推送核对不要求）；
//       每次登记另追加到 reviews/log.jsonl（轮次按分支从这里数），报告副本放在 reviews/branches/<分支>/ 下。
//   pr：复审可以与 CI 并行开始；CI 全部通过后才针对 PR 的最终提交登记。登记时用 gh 读取 PR，PR 未打开或 CI 未全部通过
//       （必需检查须为成功，判定见 lib.mjs 的 ciStatus）时拒绝。
//       记录放 git 公共目录：每个 kind 一份最新记录（merge.mjs 核对），每次登记另追加到 pr/<编号>/log.jsonl（轮次从这里数）。
// 用法：node scripts/engineering/gate/review.mjs pass|fail [--kind code|consistency] --reviewer <名> --report <报告文件> --summary "<一句话>" [--user-decision "<用户的决定及出处>"]
//       node scripts/engineering/gate/review.mjs defer --kind consistency --reason "<理由>"
//       node scripts/engineering/gate/review.mjs accept --kind code|consistency --reviewer <名> --report <报告文件> --user-decision "<用户的决定及出处>"
//       pr 流程的同样命令加 --pr <编号>，且必须带 --kind。
// 报告文件放在仓库之外（例如系统临时目录），它不属于被审代码。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertPolicy,
  defaultGh,
  gateScope,
  headInfo,
  isMain,
  loadConfig,
  prLogFile,
  prNumber,
  prRecordFile,
  readPr,
  readRecord,
  recordDir,
  repoRoot,
  treeHash,
  uncommittedInScope,
  writeRecord,
} from './lib.mjs';

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
function fenceHint(text) {
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
    const inline = new RegExp(`^\\s*(?:(?:#{1,6}[ \\t]+|>[ \\t]*|[-*+][ \\t]+)\\s*)*[*_]*${n}[\\s*_]*[:：][\\s*_]*\\S`, 'i');
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

/** 审查种类及中文名。 */
const KINDS = { code: '代码复审', consistency: '一致性审' };

/** 登记的结论种类。 */
const VERDICTS = ['pass', 'fail', 'defer', 'accept'];

/**
 * 分支名变成一层目录名：保留各种文字的字母和数字（中文分支名照常可读），斜杠等其余字符换成连字符，不以点开头；游离 HEAD 用 _detached。
 * 换过字符的名字后面加分支名的短哈希：否则 x/a 与 x-a 这样的两个分支会落到同一个目录。
 */
export function branchDirName(branch) {
  if (!branch) return '_detached';
  const safe = branch.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^\.+/, '_');
  return safe === branch ? safe : `${safe}-${crypto.createHash('sha256').update(branch).digest('hex').slice(0, 8)}`;
}

/**
 * 报告与复审者检查（pass、fail、accept 共用）。expect 是报告应有的结论（accept 要求报告结论为不通过），label 是登记的结论名。
 * 返回 { ok, message } 或 { ok: true, text }。
 */
function checkReport(config, expect, reviewer, reportPath, label = expect) {
  if (!config.reviewers.includes(reviewer)) {
    return { ok: false, message: `复审者 ${reviewer} 不在允许名单（${config.reviewers.join('、')}）内；复审必须由独立复审者（宿主子代理或外部执行器）完成，名单变更合入主干后才生效` };
  }
  if (!reportPath || !fs.existsSync(reportPath)) return { ok: false, message: '找不到复审报告文件' };
  const text = fs.readFileSync(reportPath, 'utf8');
  if (config.reviewMinChars > 0 && text.trim().length < config.reviewMinChars) {
    return { ok: false, message: `复审报告不少于 ${config.reviewMinChars} 字（当前 ${text.trim().length} 字）` };
  }
  const missing = missingSections(text, config.reviewSections);
  if (missing.length > 0) {
    return { ok: false, message: `复审报告缺少必需的节：${missing.join('、')}（每节要有单独的标题行，如“## ${missing[0]}”，或同一行写“${missing[0]}：内容”，标题下要有内容；必需的节由 modules.review.reviewSections 配置，当前是 ${config.reviewSections.join('、')}；结论一节另按“${config.reviewKeyword}”判定）${fenceHint(text)}` };
  }
  const kw = config.reviewKeyword;
  const how = `写法：同一行写“${kw}：通过。理由”或“${kw}：不通过。理由”，或者单独一行“## ${kw}”、其后第一个非空行写“通过。理由”或“不通过。理由”；结论词只认中文的通过、不通过、未通过，要单独成一个小句，结论词后不要加括号；全文只写一处结论`;
  if (!text.includes(kw)) return { ok: false, message: `复审报告缺少“${kw}”一节（${how}）` };
  const hint = fenceHint(text);
  const found = reportVerdict(text, kw);
  if (found.conflict) return { ok: false, message: `复审报告里有多处结论且不一致，无法判定（${how}）` };
  if (!found.verdict) {
    const why = found.bracketed ? '：结论词后带了括号（如“通过（待 M2 修复后）”），这种写法不认，结论词后不要加括号' : '';
    return { ok: false, message: `复审报告里找不到明确的结论${why}（${how}）${hint}` };
  }
  if (found.verdict !== expect) {
    if (label === 'accept') return { ok: false, message: `accept 要求报告结论为不通过（用户接受的是报告里未修复的问题），这份报告的结论是“通过”，应登记为 pass（${how}）` };
    const said = found.verdict === 'pass' ? '通过' : '不通过';
    return { ok: false, message: `报告结论写的是“${said}”，不能记录为 ${label}（${how}）` };
  }
  return { ok: true, text };
}

/** 读取 jsonl 历史；文件不存在时为空，坏行跳过。路径被占成目录等读不了的情况抛错（不放行）。 */
function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}

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
function failKeys(entries, keyOf) {
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
function roundBlock(prior, verdict, limit, userDecision, scope, cur, keyOf) {
  if (verdict !== 'pass' && verdict !== 'fail') return null;
  const counted = failKeys(prior, keyOf);
  if (counted.length < limit || (userDecision && userDecision.trim())) return null;
  const sameKindDone = prior.some((e, i) => keyOf(e, i) === cur.key && e.kind === cur.kind && (e.verdict === 'pass' || e.verdict === 'fail'));
  if (counted.includes(cur.key) && !sameKindDone) return null;
  return (
    `已审${cnNumber(limit)}轮仍需再审：向用户说明剩余问题、原因和已做处置，由用户决定；用户同意继续的，带 --user-decision "<用户的决定及出处>" 重新登记` +
    `（${scope}已有 ${counted.length} 份不同的被审内容登记过不通过，上限 ${limit} 轮，见 modules.review.maxReviewRounds）`
  );
}

/**
 * 登记成功后的轮次统计行：第几轮（accept、defer 不计轮次）、累计登记次数、涉及的不同提交数。entries 含本次（在最后），key 是本次的键。
 * 本次的内容已计入时就是它那一轮；还没计入（本次是 pass）时是下一轮。
 */
function roundLine(entries, verdict, limit, scope, key, keys) {
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

/** 两种流程共用的参数校验：结论种类、defer 与 accept 的必填项。返回拒绝信息或 null。 */
function argProblem({ verdict, kind, reason, userDecision }) {
  if (!VERDICTS.includes(verdict)) return '结论只能是 pass、fail、defer 或 accept';
  if (!KINDS[kind]) return '--kind 只能是 code 或 consistency';
  if (verdict === 'defer') {
    if (kind !== 'consistency') return '只有一致性审可以延期（defer 只接受 --kind consistency），代码复审不能延期';
    if (!reason || !reason.trim()) return '延期须用 --reason 写明理由';
  }
  if (verdict === 'accept' && (!userDecision || !userDecision.trim())) {
    return 'accept 须用 --user-decision 写明用户的决定及出处（例如“用户在对话中接受 M2，不再修改（2026-11-11）”）';
  }
  return null;
}

/**
 * 登记复审结论。返回 { ok, message, record? }；不通过的登记也会写入（verdict=fail），核对时只认 pass 与 accept（一致性审另认 defer）。
 * pr 流程下 gh 不存在或调用失败时抛错（不放行）；gh 可注入，测试用假的实现。
 */
export function recordReview({ root, verdict, reviewer, reportPath, summary = '', pr, kind, reason, userDecision, gh = defaultGh }) {
  const config = loadConfig(root);
  assertPolicy(config); // reviewFlow、requiredChecks、reviewers、reviewMinChars、reviewSections、reviewKeyword、maxReviewRounds 取基准提交上的配置，取不到时不按工作区的值登记
  if (config.reviewFlow === 'pr') return recordPrReview({ root, config, verdict, reviewer, reportPath, summary, pr, kind, reason, userDecision, gh });
  if (pr !== undefined) {
    return { ok: false, message: '本项目的复审流程是 pre-push，不接受 --pr；要启用 PR 双审，在主干上把 modules.gate.reviewFlow 改为 pr（闸门按基准提交上的配置判定）' };
  }
  const k = kind ?? 'code'; // 不带 --kind 时等同代码复审（旧用法）
  const bad = argProblem({ verdict, kind: k, reason, userDecision });
  if (bad) return { ok: false, message: bad };
  let text = null;
  if (verdict !== 'defer') {
    const checked = checkReport(config, verdict === 'accept' ? 'fail' : verdict, reviewer, reportPath, verdict);
    if (!checked.ok) return checked;
    text = checked.text;
  }

  // 本次改动只取一次，分成闸门范围（scope）和文档（docs）两部分，与 gate.mjs、verify.mjs 同一口径（gateScope）
  const { baseRev, changed, scope, docs } = gateScope(root, config);
  const hash = treeHash(root, scope);
  if (verdict !== 'defer') {
    const tests = readRecord(root, 'tests.json');
    if (tests && tests.passed && tests.base !== baseRev) {
      return { ok: false, message: '测试记录的基线已变化（基准提交与跑闸门时不同，例如合入了新主干），请重跑闸门（gate.mjs）' };
    }
    if (!tests || !tests.passed || tests.treeHash !== hash) {
      return { ok: false, message: '没有与当前代码一致的通过测试记录，请先运行闸门（gate.mjs）' };
    }
  }

  // 登记对应的位置：分支、HEAD 提交号、文档内容哈希、未提交的文件数（复审看的是工作区，未提交时 HEAD 不含这些改动，如实记下）
  const { branch, headSha } = headInfo(root);
  const reviews = path.join(recordDir(root), 'reviews');
  const logFile = path.join(reviews, 'log.jsonl');
  const prior = readLog(logFile).filter((e) => (e.branch ?? null) === branch);
  const scopeName = branch ? `分支 ${branch} ` : '游离 HEAD ';
  const docHash = treeHash(root, docs);
  const keys = ROUND_KEYS['pre-push'];
  const key = keys.of({ treeHash: hash, docHash }, prior.length);
  const blocked = roundBlock(prior, verdict, config.maxReviewRounds, userDecision, scopeName, { key, kind: k }, keys.of);
  if (blocked) return { ok: false, message: blocked };

  const docsOnly = scope.length === 0;
  const uncommitted = uncommittedInScope(root, changed).length;
  const dir = path.join(reviews, 'branches', branchDirName(branch));
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  let copy = null;
  if (text !== null) {
    copy = path.join(dir, `${at.replace(/[:.]/g, '-')}-${k === 'code' ? '' : `${k}-`}${verdict}.md`);
    fs.writeFileSync(copy, text);
  }
  const record = {
    kind: k, verdict, reviewer: reviewer ?? null, treeHash: hash, base: baseRev, branch, headSha, docHash, docFiles: docs.length, docsOnly, uncommitted,
    summary, reason: reason ?? null, userDecision: userDecision ?? null, report: copy, at,
  };
  // 先追加历史，再写最新记录：历史写不进去时这次登记整个不生效，不留下“命令报错但记录已生效”的状态
  fs.appendFileSync(logFile, `${JSON.stringify(record)}\n`);
  writeRecord(root, k === 'code' ? 'review.json' : 'review-consistency.json', record);

  const where = `${branch ? `分支 ${branch}` : '游离 HEAD（不在任何分支上）'}，提交 ${headSha ? headSha.slice(0, 12) : '（尚无提交）'}`;
  const lines = [`${KINDS[k]}记录已写入（${verdict}，${where}，树哈希 ${hash.slice(0, 12)}，文档 ${docs.length} 个、内容哈希 ${docHash.slice(0, 12)}）`];
  if (k === 'consistency') lines.push('一致性审记录只供核对，推送核对不要求它');
  if (verdict === 'accept') lines.push(`用户决定接受风险：${userDecision}`);
  if (docsOnly) lines.push('本次只有文档类改动（reviewIgnore 之内）：闸门范围为空，树哈希每一轮都相同，这次登记以上面的提交号和文档内容哈希为准；推送核对不要求这份记录');
  if (uncommitted > 0) lines.push(`登记时有 ${uncommitted} 个改动文件未提交：上面的提交不含这些改动，复审对应的是当时的工作区内容`);
  lines.push(roundLine([...prior, record], verdict, config.maxReviewRounds, scopeName, key, keys));
  return { ok: true, message: lines.join('\n'), record };
}

/** pr 流程的登记：校验参数与报告，核对轮次，读取 PR（须打开、CI 全过），把结论绑定到 PR 的最终提交。 */
function recordPrReview({ root, config, verdict, reviewer, reportPath, summary, pr, kind, reason, userDecision, gh }) {
  if (!VERDICTS.includes(verdict)) return { ok: false, message: '结论只能是 pass、fail、defer 或 accept' };
  if (pr === undefined || !KINDS[kind]) return { ok: false, message: '本项目的复审流程是 pr：须带 --pr <编号> 与 --kind code|consistency' };
  const no = prNumber(pr);
  const bad = argProblem({ verdict, kind, reason, userDecision });
  if (bad) return { ok: false, message: bad };
  let text = null;
  if (verdict !== 'defer') {
    const checked = checkReport(config, verdict === 'accept' ? 'fail' : verdict, reviewer, reportPath, verdict);
    if (!checked.ok) return checked;
    text = checked.text;
  }
  const logFile = prLogFile(root, no);
  const prior = readLog(logFile);
  const scopeName = `PR #${no} `;

  const st = readPr(root, no, gh, config.requiredChecks); // gh 失败时抛错；必需检查名取基准提交上的配置
  if (st.state !== 'OPEN') return { ok: false, message: `PR #${no} 不是打开状态（${st.state}），不能登记` };
  if (st.ciProblems.length > 0) return { ok: false, message: `CI 未在最终提交 ${st.head.slice(0, 12)} 上全部通过，不能登记：\n  ${st.ciProblems.join('\n  ')}` };
  // 轮次按提交计，要先知道这次登记对应 PR 的哪个最终提交
  const keys = ROUND_KEYS.pr;
  const blocked = roundBlock(prior, verdict, config.maxReviewRounds, userDecision, scopeName, { key: st.head, kind }, keys.of);
  if (blocked) return { ok: false, message: blocked };

  const file = prRecordFile(root, no, kind);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let copy = null;
  if (text !== null) {
    copy = path.join(path.dirname(file), `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}-${verdict}.md`);
    fs.writeFileSync(copy, text);
  }
  const record = { pr: no, kind, verdict, reviewer: reviewer ?? null, headSha: st.head, summary, reason: reason ?? null, userDecision: userDecision ?? null, report: copy, at: new Date().toISOString() };
  // 先追加历史（轮次按它计数），再写最新记录（merge.mjs 读它）
  fs.appendFileSync(logFile, `${JSON.stringify(record)}\n`);
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  const lines = [`已登记 PR #${no} 的${KINDS[kind]}（${verdict}，最终提交 ${st.head.slice(0, 12)}）`];
  if (verdict === 'accept') lines.push(`用户决定接受风险：${userDecision}`);
  lines.push(roundLine([...prior, record], verdict, config.maxReviewRounds, scopeName, st.head, keys));
  return { ok: true, message: lines.join('\n'), record };
}

/** 解析命令行参数：第一个位置参数是结论，其余为 --key value。 */
function parseArgs(argv) {
  const out = { verdict: argv[0] };
  for (let i = 1; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}

if (isMain(import.meta.url)) {
  try {
    const a = parseArgs(process.argv.slice(2));
    const res = recordReview({
      root: repoRoot(),
      verdict: a.verdict,
      reviewer: a.reviewer,
      reportPath: a.report,
      summary: a.summary || '',
      pr: a.pr,
      kind: a.kind,
      reason: a.reason,
      userDecision: a['user-decision'],
    });
    console.log(res.message);
    process.exit(res.ok ? 0 : 1);
  } catch (e) {
    console.error(`复审记录出错：${e.message}`);
    process.exit(1);
  }
}
