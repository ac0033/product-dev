// 复审记录：独立复审（代码复审 code 或一致性审 consistency）后在这里登记。业务含义：复审必须由不共享作者上下文的独立复审者完成——宿主子代理、外部执行器（external-review.mjs，登记名 external:<执行器>），或宿主没有子代理时用户另开的全新会话（登记名 general-purpose），且在允许名单内；
// 以 external: 开头的登记名只接受 external-review.mjs 的调用（recordReview 的 viaExternalReview 参数，命令行没有对应的参数），手动 review.mjs 登记一律拒绝；
//   外部复审的 accept 与超过轮次上限后的 --user-decision 登记也走 external-review.mjs：register（--accept、--user-decision）核对运行目录后才调用 recordReview，
//   run --register 也接受 --user-decision（复审跑完直接登记；--accept 只用于 register）；
// 判定策略（复审流程、必需检查名、复审者名单、必需的节、最少字数、结论关键词、复审轮次上限）取基准提交上的配置，被审分支改了不算数（lib.mjs 的 loadConfig）。
// 报告要有实质内容：必需的几节（modules.review.reviewSections，默认范围、发现、作者的验证，见 missingSections）齐全且各有内容，
// 并且有一处明确的结论（写法见 reportVerdict）：登记 pass 要求结论是通过，登记 fail 要求结论是不通过，
// 找不到明确结论、前后矛盾或与登记不符时拒绝。fail、accept 还须有发现表，中高级每条写理由与建议改法。常规登记如下：
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
  readLog,
  readPr,
  readRecord,
  recordDir,
  repoRoot,
  treeHash,
  uncommittedInScope,
  writeRecord,
} from './lib.mjs';
import { fenceHint, findingProblems, findingsSection, missingSections, parseFindings, reportVerdict, seriousIssues } from './report.mjs';
import { failKeys, ROUND_KEYS, roundBlock, roundLine } from './rounds.mjs';

/** 旧入口保留报告检查接口，已有调用方可继续使用。 */
export { markFences, missingSections, reportVerdict } from './report.mjs';
/** 旧入口保留按流程选取轮次键的约定。 */
export { ROUND_KEYS } from './rounds.mjs';

/** 审查种类及中文名。 */
const KINDS = { code: '代码复审', consistency: '一致性审' };
/** 外部复审者登记名的前缀（external-review.mjs 的 REVIEWER_PREFIX 取它）：这类名字只接受 external-review.mjs 的登记。 */
export const EXTERNAL_REVIEWER_PREFIX = 'external:';

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
function checkReport(config, expect, reviewer, reportPath, label = expect, reportText = null) {
  if (!config.reviewers.includes(reviewer)) {
    return { ok: false, message: `复审者 ${reviewer} 不在允许名单（${config.reviewers.join('、')}）内；复审必须由独立复审者（宿主子代理、外部执行器，或宿主没有子代理时用户另开的全新会话，后者登记名用 general-purpose）完成，名单变更合入主干后才生效` };
  }
  // reportText 是外部复审补登时已经核对过指纹的正文：直接用它，不再读一次文件（两次读取之间文件可能被换掉）
  if (typeof reportText !== 'string' && (!reportPath || !fs.existsSync(reportPath))) return { ok: false, message: '找不到复审报告文件' };
  const text = typeof reportText === 'string' ? reportText : fs.readFileSync(reportPath, 'utf8');
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
  if (expect === 'fail') {
    const section = findingsSection(config.reviewSections);
    const problems = findingProblems(text, { section });
    if (problems.length) return { ok: false, message: '复审报告发现表不合格：\n' + problems.join('\n') };
    // 与外部复审同一规则：只有低级或提示时结论是通过，不通过的报告至少要有一条高、中级发现（否则会白占一轮）
    const f = parseFindings(text, { section });
    if (f.high + f.medium === 0) return { ok: false, message: `报告结论是不通过，但发现表里没有高、中级问题：只有低级或提示时结论应为通过，不能记录为 ${label}` };
  }
  return { ok: true, text };
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** 为本次记录计算内容轮次、报告指纹和发现统计；延期没有报告，这几项为空。 */
function reportFields(prior, keyOf, key, text, section) {
  const counted = failKeys(prior, keyOf);
  const at = counted.indexOf(key);
  const round = at < 0 ? counted.length + 1 : at + 1;
  if (text === null) return { round, reportSha: null, findings: null };
  const { rows, ...findings } = parseFindings(text, { section });
  // issues：高、中级发现的编号、位置、问题，供风险登记逐条对应与收敛提示比较
  return { round, reportSha: sha256(text), findings: rows.length ? findings : null, issues: rows.length ? seriousIssues(rows) : null };
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
export function recordReview({ root, verdict, reviewer, reportPath, reportText, summary = '', pr, kind, reason, userDecision, gh = defaultGh, viaExternalReview = false }) {
  if (typeof reviewer === 'string' && reviewer.startsWith(EXTERNAL_REVIEWER_PREFIX) && viaExternalReview !== true) {
    return { ok: false, message: `复审者名 ${reviewer} 以 ${EXTERNAL_REVIEWER_PREFIX} 开头，只能由 external-review.mjs 登记（它启动执行器、核对副本与最终提交、按发现判定结论后才登记），手动 review.mjs 不接受这类名字；外部复审判不通过、用户决定接受风险，或已审满轮次上限、用户同意继续的，用 external-review.mjs register --run-dir <运行目录> --user-decision "<用户的决定及出处>"（接受不通过的结论、不再修改的另加 --accept）；宿主没有子代理而由用户另开全新会话复审的，登记名用 general-purpose` };
  }
  const config = loadConfig(root);
  assertPolicy(config); // reviewFlow、requiredChecks、reviewers、reviewMinChars、reviewSections、reviewKeyword、maxReviewRounds 取基准提交上的配置，取不到时不按工作区的值登记
  if (config.reviewFlow === 'pr') return recordPrReview({ root, config, verdict, reviewer, reportPath, reportText: viaExternalReview === true ? reportText ?? null : null, summary, pr, kind, reason, userDecision, gh });
  if (pr !== undefined) {
    return { ok: false, message: '本项目的复审流程是 pre-push，不接受 --pr；要启用 PR 双审，在主干上把 modules.gate.reviewFlow 改为 pr（闸门按基准提交上的配置判定）' };
  }
  const k = kind ?? 'code'; // 不带 --kind 时等同代码复审（旧用法）
  const bad = argProblem({ verdict, kind: k, reason, userDecision });
  if (bad) return { ok: false, message: bad };
  let text = null;
  if (verdict !== 'defer') {
    const checked = checkReport(config, verdict === 'accept' ? 'fail' : verdict, reviewer, reportPath, verdict, viaExternalReview === true ? reportText ?? null : null);
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
  const blocked = roundBlock(prior, verdict, { limit: config.maxReviewRounds, userDecision, scope: scopeName, cur: { key, kind: k }, keyOf: keys.of });
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
    ...reportFields(prior, keys.of, key, text, findingsSection(config.reviewSections)),
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
function recordPrReview({ root, config, verdict, reviewer, reportPath, reportText = null, summary, pr, kind, reason, userDecision, gh }) {
  if (!VERDICTS.includes(verdict)) return { ok: false, message: '结论只能是 pass、fail、defer 或 accept' };
  if (pr === undefined || !KINDS[kind]) return { ok: false, message: '本项目的复审流程是 pr：须带 --pr <编号> 与 --kind code|consistency' };
  const no = prNumber(pr);
  const bad = argProblem({ verdict, kind, reason, userDecision });
  if (bad) return { ok: false, message: bad };
  let text = null;
  if (verdict !== 'defer') {
    const checked = checkReport(config, verdict === 'accept' ? 'fail' : verdict, reviewer, reportPath, verdict, reportText);
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
  const blocked = roundBlock(prior, verdict, { limit: config.maxReviewRounds, userDecision, scope: scopeName, cur: { key: st.head, kind }, keyOf: keys.of });
  if (blocked) return { ok: false, message: blocked };

  const file = prRecordFile(root, no, kind);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let copy = null;
  if (text !== null) {
    copy = path.join(path.dirname(file), `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}-${verdict}.md`);
    fs.writeFileSync(copy, text);
  }
  const record = {
    ...reportFields(prior, keys.of, st.head, text, findingsSection(config.reviewSections)), pr: no, kind, verdict, reviewer: reviewer ?? null,
    headSha: st.head, summary, reason: reason ?? null, userDecision: userDecision ?? null,
    report: copy, at: new Date().toISOString(),
  };
  // 先追加历史（轮次按它计数），再写最新记录（merge.mjs 读它）
  savePrRecord(root, record);
  const lines = [`已登记 PR #${no} 的${KINDS[kind]}（${verdict}，最终提交 ${st.head.slice(0, 12)}）`];
  if (verdict === 'accept') lines.push(`用户决定接受风险：${userDecision}`);
  const entries = [...prior, record];
  lines.push(roundLine(entries, verdict, config.maxReviewRounds, scopeName, st.head, keys));
  return { ok: true, message: lines.join('\n'), record };
}

/** 先写 PR 日志再更新最新记录，日志写入失败时不能出现可放行的新记录。 */
function savePrRecord(root, record) {
  const file = prRecordFile(root, record.pr, record.kind);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(prLogFile(root, record.pr), JSON.stringify(record) + '\n');
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
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
