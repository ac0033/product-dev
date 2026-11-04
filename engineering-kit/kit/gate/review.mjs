// 复审记录：子代理复审通过（或不通过）后在这里登记，绑定当前代码树哈希。
// 业务含义：复审必须由独立于写代码者的子代理完成（允许名单内）；报告要有实质内容并给出“结论”一节；
// 报告结论写“不通过”不能记为 pass；复审前必须已有与当前代码一致的通过测试记录。
// 用法：node scripts/engineering/gate/review.mjs pass|fail --reviewer <名> --report <报告文件> --summary "<一句话>"
// 报告文件放在仓库之外（例如系统临时目录），它不属于被审代码。
import fs from 'node:fs';
import path from 'node:path';
import { isMain, loadConfig, readRecord, recordDir, repoRoot, scopeFiles, treeHash, writeRecord } from './lib.mjs';

/** 报告里写明“结论：不通过”或“结论 不通过”的形式。 */
const FAIL_IN_REPORT = /结论[\s:：]*不通过/;

/**
 * 登记复审结论。返回 { ok, message, record? }；不通过的登记也会写入（verdict=fail），推送核对时只认 pass。
 */
export function recordReview({ root, verdict, reviewer, reportPath, summary = '' }) {
  const config = loadConfig(root);
  if (verdict !== 'pass' && verdict !== 'fail') return { ok: false, message: '结论只能是 pass 或 fail' };
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

  const hash = treeHash(root, scopeFiles(root, config));
  const tests = readRecord(root, 'tests.json');
  if (!tests || !tests.passed || tests.treeHash !== hash) {
    return { ok: false, message: '没有与当前代码一致的通过测试记录，请先运行闸门（gate.mjs）' };
  }

  const dir = path.join(recordDir(root), 'reviews');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const copy = path.join(dir, `${stamp}-${verdict}.md`);
  fs.writeFileSync(copy, text);
  const record = { verdict, reviewer, treeHash: hash, summary, report: copy, at: new Date().toISOString() };
  writeRecord(root, 'review.json', record);
  return { ok: true, message: `复审记录已写入（${verdict}，树哈希 ${hash.slice(0, 12)}）`, record };
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
    });
    console.log(res.message);
    process.exit(res.ok ? 0 : 1);
  } catch (e) {
    console.error(`复审记录出错：${e.message}`);
    process.exit(1);
  }
}
