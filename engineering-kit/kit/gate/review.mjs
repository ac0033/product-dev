// 复审记录：子代理复审通过（或不通过）后在这里登记。业务含义：复审必须由独立于写代码者的子代理完成（允许名单内）；
// 报告要有实质内容并给出“结论”一节；报告结论写“不通过”不能记为 pass。按项目的复审流程（modules.gate.reviewFlow）分两种：
//   pre-push：推送前单项复审，绑定当前代码树哈希；复审前必须已有与当前代码一致的通过测试记录。
//   pr：CI 通过后针对 PR 的最终提交登记代码复审（code）或一致性审（consistency）；登记时用 gh 读取 PR，
//       PR 未打开或 CI 未全部通过时拒绝。记录放 git 公共目录，供 merge.mjs 核对。一致性审可延期（defer），须写理由。
// 用法：node scripts/engineering/gate/review.mjs pass|fail --reviewer <名> --report <报告文件> --summary "<一句话>"
//       node scripts/engineering/gate/review.mjs pass|fail --pr <编号> --kind code|consistency --reviewer <名> --report <报告文件> --summary "<一句话>"
//       node scripts/engineering/gate/review.mjs defer --pr <编号> --kind consistency --reason "<理由>"
// 报告文件放在仓库之外（例如系统临时目录），它不属于被审代码。
import fs from 'node:fs';
import path from 'node:path';
import { defaultGh, isMain, loadConfig, prNumber, prRecordFile, readPr, readRecord, recordDir, repoRoot, scopeFiles, treeHash, writeRecord } from './lib.mjs';

/** 报告里写明“结论：不通过”“结论：**不通过**”“结论：未通过”等形式（允许冒号、星号、井号、引用符、横线夹在中间）。 */
const FAIL_IN_REPORT = /结论[\s:：*#>-]*[不未]通过/;

/** pr 流程的审查种类及中文名。 */
const KINDS = { code: '代码复审', consistency: '一致性审' };

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
  if (!text.includes(config.reviewKeyword)) return { ok: false, message: `复审报告缺少“${config.reviewKeyword}”一节` };
  if (verdict === 'pass' && FAIL_IN_REPORT.test(text)) {
    return { ok: false, message: '报告结论写的是“不通过”，不能记录为 pass' };
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

  const hash = treeHash(root, scopeFiles(root, config));
  const tests = readRecord(root, 'tests.json');
  if (!tests || !tests.passed || tests.treeHash !== hash) {
    return { ok: false, message: '没有与当前代码一致的通过测试记录，请先运行闸门（gate.mjs）' };
  }

  const dir = path.join(recordDir(root), 'reviews');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const copy = path.join(dir, `${stamp}-${verdict}.md`);
  fs.writeFileSync(copy, checked.text);
  const record = { verdict, reviewer, treeHash: hash, summary, report: copy, at: new Date().toISOString() };
  writeRecord(root, 'review.json', record);
  return { ok: true, message: `复审记录已写入（${verdict}，树哈希 ${hash.slice(0, 12)}）`, record };
}

/** pr 流程的登记：校验参数与报告，读取 PR（须打开、CI 全过），把结论绑定到 PR 的最终提交。 */
function recordPrReview({ root, config, verdict, reviewer, reportPath, summary, pr, kind, reason, gh }) {
  if (!['pass', 'fail', 'defer'].includes(verdict)) return { ok: false, message: '结论只能是 pass、fail 或 defer' };
  if (pr === undefined || !KINDS[kind]) return { ok: false, message: '本项目的复审流程是 pr：须带 --pr <编号> 与 --kind code|consistency' };
  const no = prNumber(pr);
  let text = null;
  if (verdict === 'defer') {
    if (kind !== 'consistency') return { ok: false, message: '只有一致性审可以延期（defer 只接受 --kind consistency），代码复审始终必需' };
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
