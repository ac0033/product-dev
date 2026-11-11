// 合并入口（复审流程为 pr 的项目）：PR 只经这里合并。业务含义：合并时要能证明 CI 已对 PR 的最终提交全部通过，
// 且代码复审和一致性审都是针对这个最终提交做的。依次核对：PR 打开；CI 在最终提交上全部通过；代码复审有 pass 记录；
// 一致性审有 pass 或延期（defer）记录；两份记录的提交都等于当前最终提交。只改文档的 PR（全部文件在 reviewIgnore 之内，
// 与闸门同一口径：reviewFlow、reviewIgnore 等判定策略取基准提交上的配置，项目配置、豁免表和 scripts/engineering/** 永远不算文档）
// 按分档不做审查，只核对 PR 打开与 CI 全过。全部满足才执行
// gh pr merge --match-head-commit（核对之后再有人推送，GitHub 会拒绝合并），默认 squash 并删除远端分支。
// 任一项不满足就逐条列出原因、以 1 退出、不合并；gh 不存在或调用失败同样报错退出。
// 用法：node scripts/engineering/gate/merge.mjs <PR> [--method squash|merge|rebase]
import fs from 'node:fs';
import { assertPolicy, defaultGh, isIgnoredDoc, isMain, loadConfig, prNumber, prRecordFile, readPr, repoRoot, runGh } from './lib.mjs';

/** 允许的合并方式（对应 gh pr merge 的 --squash、--merge、--rebase）。 */
const METHODS = ['squash', 'merge', 'rebase'];

/** 含代码的 PR 合并前要求的审查：代码复审必需；一致性审可以是 pass，也可以是写明理由的延期。 */
const REQUIRED = [
  { kind: 'code', name: '代码复审', accept: ['pass'] },
  { kind: 'consistency', name: '一致性审', accept: ['pass', 'defer'] },
];

/** gh pr view 的 files 最多返回的文件数；达到它时列表可能被截断。 */
const GH_FILES_LIMIT = 100;

/**
 * PR 是否只改文档（全部文件都是文档，判定同闸门的 isIgnoredDoc）：按分档表这类 PR 不做代码复审、一致性审并入巡检。
 * reviewIgnore 是基准提交上的配置版本（loadConfig 得出的生效值），PR 分支自己改的 reviewIgnore 不算数；
 * 含项目配置、豁免表或 scripts/engineering/** 的 PR 不算只改文档。
 * 保守处理：文件列表为空，或达到 gh 的返回上限（可能被截断）时，不算只改文档。
 */
function docsOnly(files, reviewIgnore) {
  return files.length > 0 && files.length < GH_FILES_LIMIT && files.every((f) => isIgnoredDoc(f, reviewIgnore));
}

/** 读取一条 PR 审查记录；不存在或损坏返回 null（视为未登记）。 */
function readPrRecord(root, pr, kind) {
  try {
    return JSON.parse(fs.readFileSync(prRecordFile(root, pr, kind), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 核对并合并 PR。返回 { ok, problems, head }：ok 为 true 表示已执行合并。
 * 项目未启用 pr 流程、参数不合法、gh 失败时抛错；gh 可注入，测试用假的实现。
 */
export function mergePr({ root, pr, method = 'squash', gh = defaultGh }) {
  const config = loadConfig(root);
  assertPolicy(config); // reviewFlow、reviewIgnore 取基准提交上的配置，取不到时不按工作区的值放行
  if (config.reviewFlow !== 'pr') {
    throw new Error('本项目未启用 pr 流程（engineering.config.json 的 modules.gate.reviewFlow 不是 pr），合并入口不可用；按项目约定合并');
  }
  if (!METHODS.includes(method)) throw new Error(`合并方式只能是 ${METHODS.join('、')}（当前 ${method}）`);
  const no = prNumber(pr);
  const st = readPr(root, no, gh);
  const short = (sha) => String(sha).slice(0, 12);
  const problems = [];
  if (st.state !== 'OPEN') problems.push(`PR #${no} 不是打开状态（${st.state}）`);
  for (const p of st.ciProblems) problems.push(`${p}（最终提交 ${short(st.head)}）`);
  for (const r of docsOnly(st.files, config.reviewIgnore) ? [] : REQUIRED) {
    const rec = readPrRecord(root, no, r.kind);
    if (!rec) problems.push(`缺少${r.name}记录：先运行 review.mjs … --pr ${no} --kind ${r.kind}`);
    else if (!r.accept.includes(rec.verdict)) problems.push(`${r.name}结论是 ${rec.verdict}，不是 ${r.accept.join(' 或 ')}`);
    else if (rec.headSha !== st.head) {
      problems.push(`${r.name}记录已过期：记录针对提交 ${short(rec.headSha)}，PR 当前最终提交是 ${short(st.head)}，需对新提交重新审查并登记`);
    }
  }
  if (problems.length > 0) return { ok: false, problems, head: st.head };
  runGh(gh, ['pr', 'merge', no, `--${method}`, '--match-head-commit', st.head, '--delete-branch'], root);
  return { ok: true, problems: [], head: st.head };
}

if (isMain(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    const i = argv.indexOf('--method');
    const method = i >= 0 ? argv[i + 1] : 'squash';
    const pr = argv.find((a, k) => !a.startsWith('--') && (i < 0 || k !== i + 1));
    const res = mergePr({ root: repoRoot(), pr, method });
    if (res.ok) {
      console.log(`已合并 PR #${pr}（${method}，最终提交 ${res.head.slice(0, 12)}），远端分支已删除`);
      process.exit(0);
    }
    console.error(`合并入口未通过，未合并 PR #${pr}：`);
    for (const p of res.problems) console.error(`  - ${p}`);
    process.exit(1);
  } catch (e) {
    console.error(`合并入口出错，未合并：${e.message}`);
    process.exit(1);
  }
}
