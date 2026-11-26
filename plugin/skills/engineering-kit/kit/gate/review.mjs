// 复审记录：独立复审（代码复审 code 或一致性审 consistency）后在这里登记。业务含义：复审必须由不共享作者上下文的独立复审者完成——宿主子代理、外部执行器（external-review.mjs，登记名 external:<执行器>），或宿主没有子代理时用户另开的全新会话（登记名 general-purpose），且在允许名单内；
// 以 external: 开头的登记名只接受 external-review.mjs 的调用（recordReview 的 viaExternalReview 参数，命令行没有对应的参数），手动 review.mjs 登记一律拒绝；
//   外部复审的 accept 与超过轮次上限后的 --user-decision 登记也走 external-review.mjs：register（--accept、--user-decision）核对运行目录后才调用 recordReview，
//   run --register 也接受 --user-decision（复审跑完直接登记；--accept 只用于 register）；
// 判定策略（复审流程、必需检查名、复审者名单、必需的节、最少字数、结论关键词、复审轮次上限）取基准提交上的配置，被审分支改了不算数（lib.mjs 的 loadConfig）。
// 报告从 ek-review/1 数据生成；中高风险登记须用 --evidence-checked 写明核对的证据。
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
//       开启轮次收口后，risks --pr <编号> [--fixed-in code:M1=路径] 生成风险登记，提交后以 close --pr <编号> --summary "<说明>" 核对并登记。
// 报告文件放在仓库之外（例如系统临时目录），它不属于被审代码。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertPolicy,
  defaultGh,
  diffNames,
  forkPoint,
  git,
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
  resolveBase,
  withPrLock,
  treeHash,
  uncommittedInScope,
  writeRecord,
} from './lib.mjs';

import { COVERAGE_RULE, MAX_REVIEW_BYTES, admissionProblems, canonicalJson, compactFindings, coverageOf, fingerprint, renderReport, validateReviewData } from './review-data.mjs';
import { isRepoPath } from './config.mjs';
import { admitRegistration, closureProblems, expectedRiskEntries, nextHint, parseRiskRegister, riskKey, riskPhaseProblems, roundState } from './review-rounds.mjs';

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

/** 读取并校验提交的复审数据；外部复审直接传已经核对指纹的对象。 */
function checkedData({ config, reviewer, reportPath, reviewData }) {
  if (!config.reviewers.includes(reviewer)) {
    return { message: `复审者 ${reviewer} 不在允许名单（${config.reviewers.join('、')}）内；复审必须由独立复审者（宿主子代理、外部执行器，或宿主没有子代理时用户另开的全新会话，后者登记名用 general-purpose）完成，名单变更合入主干后才生效` };
  }
  if (Boolean(reportPath) === (reviewData !== undefined)) return { message: '请提供 JSON 报告文件或复审数据，两者须选其一' };
  let data = reviewData;
  if (reportPath) {
    if (!fs.existsSync(reportPath)) return { message: '找不到复审报告文件' };
    if (fs.statSync(reportPath).size > MAX_REVIEW_BYTES) return { message: '复审报告超过 512 KiB' };
    const bytes = fs.readFileSync(reportPath);
    if (bytes.length > MAX_REVIEW_BYTES) return { message: '复审报告超过 512 KiB' };
    try { data = JSON.parse(bytes.toString('utf8')); }
    catch { return { message: '0.9.0 起报告须为 ek-review/1 JSON，不再接受 Markdown' }; }
  }
  const issues = validateReviewData(data, { sections: config.reviewSections, flow: config.reviewFlow, minChars: config.reviewMinChars });
  return issues.length ? { message: issues.join('\n') } : { data };
}

/** 在被审树和基准树核对定位路径；推送前流程查工作区、HEAD、与主干的分叉点和数据给的基准（功能分支已提交删除的文件只在分叉点或基准的树里）。 */
function missingPaths(root, data, flow, base = null) {
  const files = new Set(data.findings.flatMap((f) => f.files ?? []));
  const inTree = (rev, file) => git(root, ['cat-file', '-e', `${rev}:${file}`]).ok;
  return [...files].filter((file) => flow === 'pr'
    ? !inTree(data.reviewedCommit, file) && !inTree(data.reviewedBase, file)
    : !fs.existsSync(path.join(root, file)) && !inTree('HEAD', file) && !(base && inTree(base, file)) && !(data.reviewedBase && inTree(data.reviewedBase, file)));
}

/**
 * pre-push 流程的覆盖。列了未交给复审者的改动文件的，不论给没给范围都只算部分覆盖；给了被审范围的（外部复审一定给），
 * 终点须是当前 HEAD、起点须是与主干的分叉点；没给范围、也没列这类文件的返回 null，不核对。基准和终点只给一个的，登记前已拒绝。
 */
function prePushCoverage(root, data, config) {
  const unreviewedFiles = data.unreviewedFiles ?? [];
  if (!data.reviewedCommit) return unreviewedFiles.length ? coverageOf({ unreviewedFiles }) : null;
  const head = git(root, ['rev-parse', 'HEAD']).out.trim();
  if (data.reviewedCommit !== head) return { full: false, why: `被审范围的终点 ${data.reviewedCommit.slice(0, 12)} 不是当前 HEAD ${head.slice(0, 12)}，之后的改动没有复审` };
  return coverageOf({
    reviewedBase: data.reviewedBase, reviewedCommit: data.reviewedCommit, coveredCommits: [], unreviewedFiles,
    forkPoint: forkPoint(root, resolveBase(root, config.base), data.reviewedCommit),
    baseIsAncestor: git(root, ['merge-base', '--is-ancestor', data.reviewedBase, data.reviewedCommit]).ok,
  });
}

/** 将规范数据与生成的报告存为一对副本，供历史索引引用。 */
function saveCopies(dir, record, data, evidenceChecked, keyword) {
  if (!data) return;
  const stem = path.join(dir, `${record.kind}-${record.at.replace(/[:.]/g, '-')}-${record.verdict}`);
  Object.assign(record, {
    data: stem + '.json', report: stem + '.md', dataSha: fingerprint(data), risk: data.risk,
    reviewedBase: data.reviewedBase, findings: compactFindings(data.findings), evidenceChecked: evidenceChecked ?? null,
  });
  fs.writeFileSync(record.data, canonicalJson(data), { flag: 'wx' });
  fs.writeFileSync(record.report, renderReport(data, { reviewer: record.reviewer, coverage: record.coverage, fingerprint: record.dataSha, keyword }), { flag: 'wx' });
}

/** 读登记历史，除空行外每行都必须是 JSON 对象。 */
export function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').flatMap((line, i) => {
    if (!line.trim()) return [];
    try {
      const value = JSON.parse(line);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) return [value];
    } catch { /* 统一报告文件名与物理行号 */ }
    throw new Error(`${file}:${i + 1} 不是合法的登记记录`);
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
function roundLine(entries, verdict, limit, scope, key, keys, counted = failKeys(entries, keys.of)) {
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
  if (!Object.hasOwn(KINDS, kind)) return '--kind 只能是 code 或 consistency';
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
export function recordReview({ root, verdict, reviewer, reportPath, reviewData, evidenceChecked, summary = '', pr, kind, reason, userDecision, gh = defaultGh, viaExternalReview = false }) {
  if (typeof reviewer === 'string' && reviewer.startsWith(EXTERNAL_REVIEWER_PREFIX) && viaExternalReview !== true) {
    return { ok: false, message: `复审者名 ${reviewer} 以 ${EXTERNAL_REVIEWER_PREFIX} 开头，只能由 external-review.mjs 登记（它启动执行器、核对副本与最终提交、按发现判定结论后才登记），手动 review.mjs 不接受这类名字；外部复审判不通过、用户决定接受风险，或已审满轮次上限、用户同意继续的，用 external-review.mjs register --run-dir <运行目录> --user-decision "<用户的决定及出处>"（接受不通过的结论、不再修改的另加 --accept）；宿主没有子代理而由用户另开全新会话复审的，登记名用 general-purpose` };
  }
  const config = loadConfig(root);
  assertPolicy(config); // reviewFlow、requiredChecks、reviewers、reviewMinChars、reviewSections、reviewKeyword、maxReviewRounds 取基准提交上的配置，取不到时不按工作区的值登记
  if (config.reviewFlow === 'pr') return recordPrReview({ root, config, verdict, reviewer, reportPath, reviewData, evidenceChecked, summary, pr, kind, reason, userDecision, gh });
  if (pr !== undefined) {
    return { ok: false, message: '本项目的复审流程是 pre-push，不接受 --pr；要启用 PR 双审，在主干上把 modules.gate.reviewFlow 改为 pr（闸门按基准提交上的配置判定）' };
  }
  const k = kind ?? 'code'; // 不带 --kind 时等同代码复审（旧用法）
  const bad = argProblem({ verdict, kind: k, reason, userDecision });
  if (bad) return { ok: false, message: bad };
  const checked = verdict === 'defer' ? {} : checkedData({ config, reviewer, reportPath, reviewData });
  if (checked.message) return { ok: false, message: checked.message };
  const { data } = checked;
  if (data && Boolean(data.reviewedCommit) !== Boolean(data.reviewedBase)) {
    return { ok: false, message: '被审范围的基准（reviewedBase）和终点（reviewedCommit）须同时给出或都不给' };
  }
  if (data) {
    let fork = null; // 基准分支解析不了时只查工作区和 HEAD（与改动前一样），覆盖另由 prePushCoverage 按被审范围判定
    try { fork = forkPoint(root, resolveBase(root, config.base), 'HEAD'); } catch { fork = null; }
    const issues = admissionProblems({ data, kind: k, verdict, flow: config.reviewFlow, evidenceChecked, coverage: prePushCoverage(root, data, config), missingFiles: missingPaths(root, data, config.reviewFlow, fork) });
    if (issues.length) return { ok: false, message: issues.join('\n') };
  }

  // 本次改动只取一次，分成闸门范围（scope）和文档（docs）两部分，与 gate.mjs、verify.mjs 同一口径（gateScope）
  const { baseRev, changed, scope, docs } = gateScope(root, config);
  const hash = treeHash(root, scope);
  // 给了被审范围的复审审的是提交；登记却绑定工作区的树。闸门范围内还有未提交的改动时，那部分没经过复审，不能登记通过
  if (data?.reviewedCommit && ['pass', 'accept'].includes(verdict)) {
    const dirty = uncommittedInScope(root, scope);
    if (dirty.length) return { ok: false, message: `复审审的是提交 ${data.reviewedCommit.slice(0, 12)}，工作区还有未提交的改动：${dirty.join('、')}；这些改动没有经过复审。先提交，再对新的 HEAD 复审后登记` };
  }
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
  const record = {
    kind: k, verdict, reviewer: reviewer ?? null, treeHash: hash, base: baseRev, branch, headSha, docHash, docFiles: docs.length, docsOnly, uncommitted,
    summary, reason: reason ?? null, userDecision: userDecision ?? null, report: null, at,
  };
  saveCopies(dir, record, data, evidenceChecked, config.reviewKeyword);
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
function recordPrReview({ root, config, verdict, reviewer, reportPath, reviewData, evidenceChecked, summary, pr, kind, reason, userDecision, gh }) {
  if (!VERDICTS.includes(verdict)) return { ok: false, message: '结论只能是 pass、fail、defer 或 accept' };
  if (pr === undefined || !Object.hasOwn(KINDS, kind)) return { ok: false, message: '本项目的复审流程是 pr：须带 --pr <编号> 与 --kind code|consistency' };
  const no = prNumber(pr);
  const bad = argProblem({ verdict, kind, reason, userDecision });
  if (bad) return { ok: false, message: bad };
  const checked = verdict === 'defer' ? {} : checkedData({ config, reviewer, reportPath, reviewData });
  if (checked.message) return { ok: false, message: checked.message };
  return withPrLock(root, no, () => registerLocked({ root, config, verdict, reviewer, data: checked.data, evidenceChecked, summary, no, kind, reason, userDecision, gh }));
}

/** 在同一把锁下读取历史、核对 PR 和覆盖范围，再登记这一轮。 */
function registerLocked({ root, config, verdict, reviewer, data, evidenceChecked, summary, no, kind, reason, userDecision, gh }) {
  const logFile = prLogFile(root, no);
  const prior = readLog(logFile);
  const scopeName = `PR #${no} `;

  const st = readPr(root, no, gh, config.requiredChecks); // gh 失败时抛错；必需检查名取基准提交上的配置
  if (st.state !== 'OPEN') return { ok: false, message: `PR #${no} 不是打开状态（${st.state}），不能登记` };
  if (st.ciProblems.length > 0) return { ok: false, message: `CI 未在最终提交 ${st.head.slice(0, 12)} 上全部通过，不能登记：\n  ${st.ciProblems.join('\n  ')}` };
  let coverage;
  if (data) {
    const { reviewedBase, reviewedCommit } = data;
    const unavailable = [reviewedCommit, reviewedBase].filter((rev) => !git(root, ['cat-file', '-e', `${rev}^{commit}`]).ok);
    // 只接续带结构化数据副本、且写明按当前覆盖规则判定的登记：更早的记录在旧规则下判的覆盖，可能漏算没交给复审者的改动文件，无法证明完整
    const coveredCommits = prior.filter((r) => r.kind === kind && ['pass', 'fail', 'accept'].includes(r.verdict) && r.coverage === 'full' && r.dataSha && r.coverageRule >= COVERAGE_RULE).map((r) => r.headSha);
    coverage = coverageOf({ reviewedBase, reviewedCommit, coveredCommits, unreviewedFiles: data.unreviewedFiles ?? [],
      forkPoint: forkPoint(root, resolveBase(root, config.base), reviewedCommit),
      baseIsAncestor: git(root, ['merge-base', '--is-ancestor', reviewedBase, reviewedCommit]).ok,
    });
    const issues = admissionProblems({ data, verdict, kind, flow: 'pr', prHead: st.head, prior, evidenceChecked, coverage, missingFiles: missingPaths(root, data, 'pr') });
    if (unavailable.length) issues.push(`本地没有被审提交或基准 ${unavailable.join('、')}，请先 git fetch`);
    if (issues.length) return { ok: false, message: issues.join('\n') };
  }
  // 轮次按提交计，要先知道这次登记对应 PR 的哪个最终提交
  const keys = ROUND_KEYS.pr;
  const closureEnabled = config.roundClosure === 'fix-and-record';
  const blocked = closureEnabled
    ? admitRegistration(prRoundState(config, prior), { verdict, kind, head: st.head, userDecision })
    : roundBlock(prior, verdict, config.maxReviewRounds, userDecision, scopeName, { key: st.head, kind }, keys.of);
  if (blocked) return { ok: false, message: blocked };

  const file = prRecordFile(root, no, kind);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = { pr: no, kind, verdict, reviewer: reviewer ?? null, headSha: st.head, summary, reason: reason ?? null, userDecision: userDecision ?? null, report: null, at: new Date().toISOString() };
  if (coverage) Object.assign(record, { coverage: coverage.full ? 'full' : 'partial', coverageRule: COVERAGE_RULE });
  saveCopies(path.dirname(file), record, data, evidenceChecked, config.reviewKeyword);
  // 先追加历史（轮次按它计数），再写最新记录（merge.mjs 读它）
  savePrRecord(file, logFile, record);
  const lines = [`已登记 PR #${no} 的${KINDS[kind]}（${verdict}，最终提交 ${st.head.slice(0, 12)}）`];
  if (verdict === 'accept') lines.push(`用户决定接受风险：${userDecision}`);
  const entries = [...prior, record];
  const updated = closureEnabled ? prRoundState(config, entries) : null;
  lines.push(roundLine(entries, verdict, config.maxReviewRounds, scopeName, st.head, keys, updated?.rounds.map((r) => r.head)));
  const hint = updated && nextHint(updated);
  if (hint) lines.push(hint);
  return { ok: true, message: lines.join('\n'), record };
}

/** 使用生效的基准配置计算同一份 PR 历史的状态。 */
export function prRoundState(config, entries) {
  return roundState({ entries, limit: config.maxReviewRounds, closure: config.roundClosure });
}

/** 在 PR 锁内更新历史和最新记录。快照替换失败时撤销本次追加。 */
function savePrRecord(file, logFile, record) {
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  const length = fs.statSync(logFile, { throwIfNoEntry: false })?.size;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  try {
    fs.appendFileSync(logFile, JSON.stringify(record) + '\n');
    fs.renameSync(tmp, file);
  } catch (err) {
    if (length === undefined) fs.rmSync(logFile, { force: true });
    else fs.truncateSync(logFile, length);
    throw err;
  } finally { fs.rmSync(tmp, { force: true }); }
}

/** 从失败登记的数据副本读完整发现，逐字节核对登记时保存的指纹。 */
export function readFailureFindings(record) {
  if (!record.data) throw new Error('上轮失败登记缺少复审数据副本');
  if (fs.statSync(record.data).size > MAX_REVIEW_BYTES) throw new Error('上一轮复审数据超过 512 KiB');
  const bytes = fs.readFileSync(record.data);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== record.dataSha) throw new Error('上轮失败登记的数据副本指纹不符');
  return JSON.parse(bytes).findings;
}

function riskEvidence(pr, latest) {
  const failures = [];
  const problems = [];
  for (const record of Object.values(latest?.failures ?? {})) {
    try { failures.push({ kind: record.kind, findings: readFailureFindings(record) }); }
    catch (e) { problems.push(record.kind + ' 复审数据副本无法核对：' + e.message); }
  }
  const expected = expectedRiskEntries({ pr, round: latest?.index, failHead: latest?.head, failures });
  return { expected, problems };
}

/** 锁内以 PR 最终提交为准收集事实；close 和 merge 共用同一组证据和拒绝原因。 */
export function checkPrClosure(root, no, config, st, priorClose = {}) {
  const state = prRoundState(config, readLog(prLogFile(root, no)));
  const failHead = state.latest?.head;
  const evidence = riskEvidence(no, state.latest);
  const registerPath = config.riskRegister;
  const blob = git(root, ['show', st.head + ':' + registerPath]);
  const diff = failHead && diffNames(root, [failHead, st.head]);
  const problems = closureProblems({
    closure: config.roundClosure, flow: config.reviewFlow, state, prOpen: st.state === 'OPEN', ciProblems: st.ciProblems,
    head: st.head, failHead, headIsDescendant: !!failHead && git(root, ['merge-base', '--is-ancestor', failHead, st.head]).ok,
    registerPath, register: blob.ok ? parseRiskRegister(blob.out) : null, expected: evidence.expected,
    fixDiff: diff?.files ?? [],
    ...priorClose,
  });
  if (diff && !diff.ok) problems.push('无法读取最新失败提交到最终提交的修复差异');
  problems.push(...evidence.problems);
  return { failHead, round: state.latest?.index, entries: evidence.expected.length, problems };
}

/** 更新本轮中级发现的实际修复位置。参数可重复，同一编号在两种审查里都有时须带种类。 */
function applyFixedIn(expected, fixedIn) {
  for (const spec of fixedIn) {
    const match = /^(?:(code|consistency):)?(M[1-9]\d*)=(.+)$/u.exec(spec);
    if (!match) return '--fixed-in 须为 [审查种类:]编号=路径[,路径]';
    const [, kind, id, paths] = match;
    const files = paths.split(',');
    if (!files.every(isRepoPath)) return '--fixed-in 须写仓库相对路径：' + paths;
    const matches = expected.filter((e) => e.id === id && (!kind || e.kind === kind));
    if (matches.length !== 1) return '--fixed-in 找不到唯一的本轮中级发现：' + spec;
    const [entry] = matches;
    entry.fixedIn = [...new Set([...entry.fixedIn, ...files])];
  }
  return null;
}

/** 按配置的仓库路径写风险登记；工作区的路径组件不得把读写重定向到链接目标。 */
function registerFile(root, rel) {
  let file = root;
  for (const part of rel.split('/')) {
    file = path.join(file, part);
    if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('风险登记路径含符号链接：' + file);
  }
  return file;
}

/** 在 PR 锁内生成可提交的风险登记；其余条目的原文保留。返回操作结果和下一步。 */
export function writeRisks({ root, pr, fixedIn = [] }) {
  const no = prNumber(pr);
  const config = loadConfig(root);
  assertPolicy(config);
  return withPrLock(root, no, () => {
    const state = prRoundState(config, readLog(prLogFile(root, no)));
    const problems = riskPhaseProblems({ closure: config.roundClosure, flow: config.reviewFlow, state });
    if (problems.length) return { ok: false, message: problems.join('\n') };
    const evidence = riskEvidence(no, state.latest);
    if (evidence.problems.length) return { ok: false, message: evidence.problems.join('\n') };
    const entries = evidence.expected;
    const bad = applyFixedIn(entries, fixedIn);
    if (bad) return { ok: false, message: bad };
    const file = registerFile(root, config.riskRegister);
    const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const parsed = parseRiskRegister(original);
    if (parsed.problems.length) return { ok: false, message: parsed.problems.join('\n') };
    const replace = new Set(entries.map(riskKey));
    const lines = original.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    let index = 0;
    const kept = lines.filter((line) => !line.trim() || !replace.has(riskKey(parsed.entries[index++])));
    const content = kept.concat(entries.map((e) => JSON.stringify(e))).join('\n') + '\n';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(tmp, content, { flag: 'wx' });
      fs.renameSync(tmp, file);
    } finally { fs.rmSync(tmp, { force: true }); }
    return { ok: true, message: '已写入 ' + entries.length + ' 条风险登记到 ' + config.riskRegister + '，提交并推送后运行 review.mjs close' };
  });
}

/** 核对最终提交及本轮全部中级风险的修复证据，成功后在锁内登记收口。 */
export function closeRound({ root, pr, summary, gh = defaultGh }) {
  const no = prNumber(pr);
  const config = loadConfig(root);
  assertPolicy(config);
  return withPrLock(root, no, () => {
    const st = readPr(root, no, gh, config.requiredChecks);
    const { failHead, round, entries, problems } = checkPrClosure(root, no, config, st);
    if (!summary?.trim()) problems.push('收口须用 --summary 写明说明');
    if (problems.length) return { ok: false, message: problems.join('\n') };
    const record = { kind: 'close', verdict: 'close', headSha: st.head, failHead, round, riskRegister: config.riskRegister, entries, summary, at: new Date().toISOString() };
    savePrRecord(prRecordFile(root, no, 'close'), prLogFile(root, no), record);
    return { ok: true, message: '已登记 PR #' + no + ' 第 ' + round + ' 轮收口，核对了 ' + entries + ' 条风险登记' };
  });
}

/** 解析命令行参数：第一个位置参数是结论或收口命令，其余为 --key value。 */
function parseArgs(argv) {
  const out = { verdict: argv[0] };
  const allowed = ['--kind', '--reviewer', '--report', '--summary', '--user-decision', '--evidence-checked', '--reason', '--pr'];
  if (out.verdict === 'risks') allowed.push('--fixed-in');
  for (let i = 1; i < argv.length; i += 2) {
    if (!allowed.includes(argv[i])) {
      const hint = argv[i] === '--viaExternalReview' ? '；external: 复审者只能由 external-review.mjs 登记' : '';
      throw new Error(`未知参数：${argv[i]}${hint}`);
    }
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${argv[i]} 缺少值`);
    if (argv[i] === '--fixed-in') (out.fixedIn ??= []).push(argv[i + 1]);
    else out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

if (isMain(import.meta.url)) {
  try {
    const a = parseArgs(process.argv.slice(2));
    const root = repoRoot();
    const command = { risks: writeRisks, close: closeRound };
    const res = Object.hasOwn(command, a.verdict) ? command[a.verdict]({ ...a, root }) : recordReview({
      root,
      verdict: a.verdict,
      reviewer: a.reviewer,
      reportPath: a.report,
      summary: a.summary || '',
      pr: a.pr,
      kind: a.kind,
      reason: a.reason,
      userDecision: a['user-decision'],
      evidenceChecked: a['evidence-checked'],
    });
    console.log(res.message);
    process.exit(res.ok ? 0 : 1);
  } catch (e) {
    console.error(`复审记录出错：${e.message}`);
    process.exit(1);
  }
}
