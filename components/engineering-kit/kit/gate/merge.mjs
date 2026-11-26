// 合并入口（复审流程为 pr 的项目）：PR 只经这里合并。业务含义：合并时要能证明 CI 已对 PR 的最终提交全部通过，
// 且代码复审和一致性审都是针对这个最终提交做的。依次核对：PR 打开；CI 在最终提交上全部通过（必需检查须为成功，
// 跳过、中性只放行非必需检查，判定见 lib.mjs 的 ciStatus；输出把通过项与被放行的跳过项分开列出）；代码复审有 pass 记录；
// 一致性审有 pass 或延期（defer）记录；两份记录的提交都等于当前最终提交。两种审查的 accept（报告不通过、用户已知情并决定接受风险）
// 同样放行，输出写明“按用户决定接受风险放行”。代码复审记录之后 PR 只改了文档（记录的提交到最终提交之间的差异全是文档，
// 判定同 isIgnoredDoc）时仍认这份代码复审记录并写明两个提交；本地算不出差异（没有这两个提交等）时按过期处理。
// 一致性审记录不享受这一条，仍须针对最终提交。改名一律按旧路径删除加新路径新增计（lib.mjs 的 diffNames）。
// 只改文档的 PR（本地算出的基准提交到最终提交之间的全部文件在 reviewIgnore 之内，本地没有最终提交时按含代码处理，
// 与闸门同一口径：reviewFlow、reviewIgnore 等判定策略取基准提交上的配置，项目配置、豁免表和 scripts/engineering/** 永远不算文档）
// 按分档不做审查，只核对 PR 打开与 CI 全过。全部满足才执行
// 开启轮次收口时，收口记录可代两项审查；在最终提交上重新核对风险登记后才能放行。
// gh pr merge --match-head-commit（核对之后再有人推送，GitHub 会拒绝合并），默认 squash 并删除远端分支。
// 任一项不满足就逐条列出原因、以 1 退出、不合并；gh 不存在或调用失败同样报错退出。
// 用法：node scripts/engineering/gate/merge.mjs <PR> [--method squash|merge|rebase]
import { closeClearance, docsOnlyPr, recordClears, REQUIRED } from './clearance.mjs';
import { assertPolicy, defaultGh, isMain, loadConfig, prNumber, readPr, repoRoot, runGh } from './lib.mjs';

/** 允许的合并方式（对应 gh pr merge 的 --squash、--merge、--rebase）。 */
const METHODS = ['squash', 'merge', 'rebase'];

/**
 * 核对并合并 PR。返回 { ok, problems, notes, head, ci }：ok 为 true 表示已执行合并；notes 是放行时要写明的说明
 * （按用户决定接受风险放行、沿用只改文档之前的代码复审记录、本地判断不了是否只改文档的原因）；
 * ci 是 ciStatus 的结果，其中 passed（成功的检查）与 skipped（被放行的跳过或中性的非必需检查）由命令行分开报告。
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
  const st = readPr(root, no, gh, config.requiredChecks);
  const short = (sha) => String(sha).slice(0, 12);
  const problems = [];
  const notes = [];
  if (st.state !== 'OPEN') problems.push(`PR #${no} 不是打开状态（${st.state}）`);
  for (const p of st.ciProblems) problems.push(`${p}（最终提交 ${short(st.head)}）`);
  const scope = docsOnlyPr(root, config, st.head);
  if (scope.why) notes.push(scope.why);
  if (!scope.docs) {
    // 两条放行路径：有效的收口记录，或普通双审。收口记录失效（例如之后改坏了风险登记）时不挡住普通双审，两条都不满足才拒绝
    const closed = closeClearance(root, no, st.head, config);
    const normal = { problems: [], notes: [] };
    if (!closed || closed.problems.length) {
      for (const r of REQUIRED) {
        const result = recordClears(root, no, st.head, config, r);
        normal.problems.push(...result.problems);
        normal.notes.push(...result.notes);
      }
    }
    if (closed && !closed.problems.length) notes.push(...closed.notes);
    else if (!normal.problems.length) notes.push(...normal.notes, ...(closed ? [`收口记录不再有效（${closed.problems.join('；')}），按普通双审放行`] : []));
    else problems.push(...normal.problems, ...(closed ? closed.problems.map((p) => `收口：${p}`) : []));
  }
  if (problems.length > 0) return { ok: false, problems, notes, head: st.head, ci: st.ci };
  runGh(gh, ['pr', 'merge', no, `--${method}`, '--match-head-commit', st.head, '--delete-branch'], root);
  return { ok: true, problems: [], notes, head: st.head, ci: st.ci };
}

/** CI 结果的报告行：成功的检查一行（标明必需与否），被放行的跳过或中性的非必需检查另起一行，不与成功项混在一起。 */
export function ciLines(ci) {
  const out = [];
  if (!ci) return out;
  const req = ci.passed.filter((p) => p.required).map((p) => p.label ?? p.name);
  const opt = ci.passed.filter((p) => !p.required).map((p) => p.label ?? p.name);
  if (req.length) out.push(`CI 必需检查成功：${req.join('、')}`);
  if (opt.length) out.push(`CI 非必需检查成功：${opt.join('、')}`);
  if (ci.skipped.length) out.push(`CI 非必需检查跳过或中性（放行，不算通过）：${ci.skipped.map((s) => `${s.label ?? s.name}（${s.result}）`).join('、')}`);
  return out;
}

if (isMain(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    const i = argv.indexOf('--method');
    const method = i >= 0 ? argv[i + 1] : 'squash';
    const pr = argv.find((a, k) => !a.startsWith('--') && (i < 0 || k !== i + 1));
    const res = mergePr({ root: repoRoot(), pr, method });
    for (const l of ciLines(res.ci)) console.log(l);
    for (const n of res.notes) console.log(n);
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
