// 复审记录：子代理复审通过（或不通过）后在这里登记。业务含义：复审必须由独立于写代码者的子代理完成（允许名单内）；
// 报告要有实质内容，并且有一处明确的结论（写法见 reportVerdict）：登记 pass 要求结论是通过，登记 fail 要求结论是不通过，
// 找不到明确结论、前后矛盾或与登记不符时拒绝。按项目的复审流程（modules.gate.reviewFlow）分两种：
//   pre-push：推送前单项复审，绑定当前代码树哈希和基准提交（基线）；复审前必须已有与当前代码、当前基线一致的通过测试记录。
//       闸门范围与 gate.mjs、verify.mjs 同一口径（lib.mjs 的 gateScope）。
//       代码树哈希不含文档（reviewIgnore），只改规则文本这类改动每一轮的树哈希都相同，所以登记另外写明分支、HEAD 提交号、
//       文档内容哈希和登记时未提交的文件数，用来把每次登记对应到具体的分支和提交；推送核对（verify.mjs）认树哈希与基线。
//       最新一条写 review.json（推送核对读它）；每次登记另追加到 reviews/log.jsonl，报告副本放在 reviews/branches/<分支>/ 下。
//   pr：CI 通过后针对 PR 的最终提交登记代码复审（code）或一致性审（consistency）；登记时用 gh 读取 PR，
//       PR 未打开或 CI 未全部通过时拒绝。记录放 git 公共目录，供 merge.mjs 核对。一致性审可延期（defer），须写理由。
// 用法：node scripts/engineering/gate/review.mjs pass|fail --reviewer <名> --report <报告文件> --summary "<一句话>"
//       node scripts/engineering/gate/review.mjs pass|fail --pr <编号> --kind code|consistency --reviewer <名> --report <报告文件> --summary "<一句话>"
//       node scripts/engineering/gate/review.mjs defer --pr <编号> --kind consistency --reason "<理由>"
// 报告文件放在仓库之外（例如系统临时目录），它不属于被审代码。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  defaultGh,
  gateScope,
  headInfo,
  isMain,
  loadConfig,
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

/** 一段文字是不是单独的结论词：通过 / 不通过 / 未通过（允许后面跟括号说明和句末标点）。返回 pass、fail 或 null。 */
function verdictWord(s) {
  const t = plain(s).replace(/[（(][^）)]*[）)]/g, '').replace(/[。.！!]+$/, '').trim();
  if (t === '通过') return 'pass';
  if (t === '不通过' || t === '未通过') return 'fail';
  return null;
}

/** 一行以哪个结论词开头（先认“不通过”“未通过”，再认“通过”）。返回 pass、fail 或 null。 */
function leadingVerdict(s) {
  const t = plain(s);
  if (/^[不未]通过/.test(t)) return 'fail';
  if (/^通过/.test(t)) return 'pass';
  return null;
}

/**
 * 从报告里找出明确的结论。认两种写法（keyword 默认是“结论”，可配置）：
 *   同一行：`结论：通过` / `结论：不通过`，行首允许井号、引用符、列表符，词两边允许星号；冒号后按逗号、分号拆成小句，
 *     恰好是结论词的小句才算（所以“有 2 个高级问题，不通过”是不通过，“未通过的问题已修复，通过”是通过）。
 *   标题行：只有关键词的一行（如 `## 结论`），其后第一个非空行以 通过 / 不通过 / 未通过 开头。
 * 返回 { verdict: 'pass'|'fail'|null, conflict }：找不到时 verdict 为 null；出现多处且不一致时 conflict 为 true、verdict 为 null。
 */
export function reportVerdict(text, keyword = '结论') {
  const k = escapeRe(keyword);
  const heading = new RegExp(`^[\\s>#*_-]*${k}[\\s*_]*[:：]?[\\s*_]*$`);
  const inline = new RegExp(`^[\\s>#*_-]*${k}(?:[\\s*_]*[:：]|[\\s*_]+)[\\s*_]*(.+)$`);
  const lines = String(text).split(/\r?\n/);
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (heading.test(line)) {
      const next = lines.slice(i + 1).find((l) => l.trim() !== '');
      const v = next === undefined ? null : leadingVerdict(next.replace(/^[\s>-]*/, ''));
      if (v) found.push(v);
      continue;
    }
    const m = inline.exec(line);
    if (!m) continue;
    const words = new Set(m[1].split(/[，,；;]/).map(verdictWord).filter(Boolean));
    if (words.size === 1) found.push([...words][0]);
    else if (words.size > 1) found.push('pass', 'fail'); // 同一行里既写通过又写不通过：按矛盾处理
  }
  const kinds = new Set(found);
  if (kinds.size > 1) return { verdict: null, conflict: true };
  return { verdict: kinds.size === 1 ? [...kinds][0] : null, conflict: false };
}

/** pr 流程的审查种类及中文名。 */
const KINDS = { code: '代码复审', consistency: '一致性审' };

/**
 * 分支名变成一层目录名：保留各种文字的字母和数字（中文分支名照常可读），斜杠等其余字符换成连字符，不以点开头；游离 HEAD 用 _detached。
 * 换过字符的名字后面加分支名的短哈希：否则 x/a 与 x-a 这样的两个分支会落到同一个目录。
 */
export function branchDirName(branch) {
  if (!branch) return '_detached';
  const safe = branch.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^\.+/, '_');
  return safe === branch ? safe : `${safe}-${crypto.createHash('sha256').update(branch).digest('hex').slice(0, 8)}`;
}

/** 报告与复审者检查（两种流程的 pass、fail 共用）。返回 { ok, message } 或 { ok: true, text }。 */
function checkReport(config, verdict, reviewer, reportPath) {
  if (!config.reviewers.includes(reviewer)) {
    return { ok: false, message: `复审者 ${reviewer} 不在允许名单（${config.reviewers.join('、')}）内；复审必须由独立子代理完成` };
  }
  if (!reportPath || !fs.existsSync(reportPath)) return { ok: false, message: '找不到复审报告文件' };
  const text = fs.readFileSync(reportPath, 'utf8');
  if (text.trim().length < config.reviewMinChars) {
    return { ok: false, message: `复审报告不少于 ${config.reviewMinChars} 字（当前 ${text.trim().length} 字）` };
  }
  const kw = config.reviewKeyword;
  const how = `写法：同一行写“${kw}：通过”或“${kw}：不通过”，或者单独一行“## ${kw}”、其后第一个非空行以“通过”或“不通过”开头；全文只写一处结论`;
  if (!text.includes(kw)) return { ok: false, message: `复审报告缺少“${kw}”一节（${how}）` };
  const found = reportVerdict(text, kw);
  if (found.conflict) return { ok: false, message: `复审报告里有多处结论且不一致，无法判定（${how}）` };
  if (!found.verdict) return { ok: false, message: `复审报告里找不到明确的结论（${how}）` };
  if (found.verdict !== verdict) {
    const said = found.verdict === 'pass' ? '通过' : '不通过';
    return { ok: false, message: `报告结论写的是“${said}”，不能记录为 ${verdict}（${how}）` };
  }
  return { ok: true, text };
}

/**
 * 登记复审结论。返回 { ok, message, record? }；不通过的登记也会写入（verdict=fail），核对时只认 pass（一致性审另认 defer）。
 * pr 流程下 gh 不存在或调用失败时抛错（不放行）；gh 可注入，测试用假的实现。
 */
export function recordReview({ root, verdict, reviewer, reportPath, summary = '', pr, kind, reason, gh = defaultGh }) {
  const config = loadConfig(root);
  if (config.reviewFlow === 'pr') return recordPrReview({ root, config, verdict, reviewer, reportPath, summary, pr, kind, reason, gh });
  if (pr !== undefined || kind !== undefined) {
    return { ok: false, message: '本项目的复审流程是 pre-push，不接受 --pr、--kind；要启用 PR 双审，把 modules.gate.reviewFlow 改为 pr' };
  }
  if (verdict !== 'pass' && verdict !== 'fail') return { ok: false, message: '结论只能是 pass 或 fail' };
  const checked = checkReport(config, verdict, reviewer, reportPath);
  if (!checked.ok) return checked;

  // 本次改动只取一次，分成闸门范围（scope）和文档（docs）两部分，与 gate.mjs、verify.mjs 同一口径（gateScope）
  const { baseRev, changed, scope, docs } = gateScope(root, config);
  const hash = treeHash(root, scope);
  const tests = readRecord(root, 'tests.json');
  if (tests && tests.passed && tests.base !== baseRev) {
    return { ok: false, message: '测试记录的基线已变化（基准提交与跑闸门时不同，例如合入了新主干），请重跑闸门（gate.mjs）' };
  }
  if (!tests || !tests.passed || tests.treeHash !== hash) {
    return { ok: false, message: '没有与当前代码一致的通过测试记录，请先运行闸门（gate.mjs）' };
  }

  // 登记对应的位置：分支、HEAD 提交号、文档内容哈希、未提交的文件数（复审看的是工作区，未提交时 HEAD 不含这些改动，如实记下）
  const { branch, headSha } = headInfo(root);
  const docHash = treeHash(root, docs);
  const docsOnly = scope.length === 0;
  const uncommitted = uncommittedInScope(root, changed).length;

  const reviews = path.join(recordDir(root), 'reviews');
  const dir = path.join(reviews, 'branches', branchDirName(branch));
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  const copy = path.join(dir, `${at.replace(/[:.]/g, '-')}-${verdict}.md`);
  fs.writeFileSync(copy, checked.text);
  const record = { verdict, reviewer, treeHash: hash, base: baseRev, branch, headSha, docHash, docFiles: docs.length, docsOnly, uncommitted, summary, report: copy, at };
  // 先追加历史，再写最新记录：历史写不进去时这次登记整个不生效，不留下“命令报错但记录已生效”的状态
  fs.appendFileSync(path.join(reviews, 'log.jsonl'), `${JSON.stringify(record)}\n`);
  writeRecord(root, 'review.json', record);

  const where = `${branch ? `分支 ${branch}` : '游离 HEAD（不在任何分支上）'}，提交 ${headSha ? headSha.slice(0, 12) : '（尚无提交）'}`;
  const lines = [`复审记录已写入（${verdict}，${where}，树哈希 ${hash.slice(0, 12)}，文档 ${docs.length} 个、内容哈希 ${docHash.slice(0, 12)}）`];
  if (docsOnly) lines.push('本次只有文档类改动（reviewIgnore 之内）：闸门范围为空，树哈希每一轮都相同，这次登记以上面的提交号和文档内容哈希为准；推送核对不要求这份记录');
  if (uncommitted > 0) lines.push(`登记时有 ${uncommitted} 个改动文件未提交：上面的提交不含这些改动，复审对应的是当时的工作区内容`);
  return { ok: true, message: lines.join('\n'), record };
}

/** pr 流程的登记：校验参数与报告，读取 PR（须打开、CI 全过），把结论绑定到 PR 的最终提交。 */
function recordPrReview({ root, config, verdict, reviewer, reportPath, summary, pr, kind, reason, gh }) {
  if (!['pass', 'fail', 'defer'].includes(verdict)) return { ok: false, message: '结论只能是 pass、fail 或 defer' };
  if (pr === undefined || !KINDS[kind]) return { ok: false, message: '本项目的复审流程是 pr：须带 --pr <编号> 与 --kind code|consistency' };
  const no = prNumber(pr);
  let text = null;
  if (verdict === 'defer') {
    if (kind !== 'consistency') return { ok: false, message: '只有一致性审可以延期（defer 只接受 --kind consistency），代码复审不能延期' };
    if (!reason || !reason.trim()) return { ok: false, message: '延期须用 --reason 写明理由' };
  } else {
    const checked = checkReport(config, verdict, reviewer, reportPath);
    if (!checked.ok) return checked;
    text = checked.text;
  }

  const st = readPr(root, no, gh); // gh 失败时抛错
  if (st.state !== 'OPEN') return { ok: false, message: `PR #${no} 不是打开状态（${st.state}），不能登记` };
  if (st.ciProblems.length > 0) return { ok: false, message: `CI 未在最终提交 ${st.head.slice(0, 12)} 上全部通过，不能登记：\n  ${st.ciProblems.join('\n  ')}` };

  const file = prRecordFile(root, no, kind);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let copy = null;
  if (text !== null) {
    copy = path.join(path.dirname(file), `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}-${verdict}.md`);
    fs.writeFileSync(copy, text);
  }
  const record = { pr: no, kind, verdict, reviewer: reviewer ?? null, headSha: st.head, summary, reason: reason ?? null, report: copy, at: new Date().toISOString() };
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return { ok: true, message: `已登记 PR #${no} 的${KINDS[kind]}（${verdict}，最终提交 ${st.head.slice(0, 12)}）`, record };
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
    });
    console.log(res.message);
    process.exit(res.ok ? 0 : 1);
  } catch (e) {
    console.error(`复审记录出错：${e.message}`);
    process.exit(1);
  }
}
