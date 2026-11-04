// 推送前核对：git pre-push 钩子与 Claude 推送钩子共用。业务含义：本次改动含源文件时，必须同时满足
//   静态检查通过（测试先行、注释）、测试记录通过、复审记录通过，且两份记录都对应当前代码树。
// 闸门范围 = 本次改动中去掉 reviewIgnore（文档）的部分：源文件、闸门脚本、配置都要记录。只改文档的推送直接放行。
// 范围内有未提交改动、基准分支解析不了时拒绝。失败时列出阻塞原因，退出码 1。
// 用法：node scripts/engineering/gate/verify.mjs
import { checkComments } from './check-comments.mjs';
import { checkTestFirst } from './check-test-first.mjs';
import {
  changedFiles,
  isMain,
  isSourceFile,
  loadConfig,
  loadExempt,
  matchesAny,
  readRecord,
  repoRoot,
  scopeFiles,
  treeHash,
  uncommittedInScope,
} from './lib.mjs';

/** 核对推送条件。返回 { ok, problems, note }。 */
export function verify({ root }) {
  const config = loadConfig(root);
  const exempt = loadExempt(root);
  const changed = changedFiles(root, config.base);
  const sources = changed.filter((f) => isSourceFile(f, config) && !matchesAny(f, config.reviewIgnore));
  const scope = scopeFiles(root, config);
  // 范围 = 本次所有非忽略的改动（源文件、闸门脚本、配置等）。只有文档类改动才可以不要记录。
  if (scope.length === 0) return { ok: true, problems: [], note: '本次只有文档类改动（reviewIgnore 之内），无需闸门记录' };

  const problems = [
    ...checkTestFirst({ root, changed, config, exempt: exempt.testFirst }).map((p) => p.message),
    ...checkComments({ root, files: sources, config, exempt: exempt.comments }).map((p) => p.message),
  ];
  // 推送的是提交；闸门核对的是工作区。范围内有未提交的改动时两者不是同一份代码，必须先提交再核对。
  const uncommitted = uncommittedInScope(root, scope); // git 失败时抛错，不放行
  if (uncommitted.length > 0) problems.push(`范围内有未提交的改动，推送的不是已闸门的代码，请先提交（或撤销）：\n  ${uncommitted.join('\n  ')}`);
  const hash = treeHash(root, scope);

  const tests = readRecord(root, 'tests.json');
  if (!tests) problems.push('没有测试记录：先运行 node scripts/engineering/gate/gate.mjs');
  else if (!tests.passed) problems.push('最近一次测试未通过（或运行期间代码变化）');
  else if (tests.treeHash !== hash) problems.push('测试记录与当前代码不一致（代码已变化），请重跑闸门');

  const review = readRecord(root, 'review.json');
  if (!review) problems.push('没有复审记录：复审通过后运行 review.mjs pass --reviewer ... --report ...');
  else if (review.verdict !== 'pass') problems.push('最近一次复审结论不是通过');
  else if (review.treeHash !== hash) problems.push('复审记录与当前代码不一致（复审之后代码变了），需重跑闸门并重新复审');

  return { ok: problems.length === 0, problems, note: '' };
}

if (isMain(import.meta.url)) {
  try {
    const res = verify({ root: repoRoot() });
    if (res.note) console.log(res.note);
    if (res.ok) {
      console.log('推送闸门：通过');
      process.exit(0);
    }
    console.error('推送闸门未通过，阻塞原因：');
    for (const p of res.problems) console.error(`  - ${p}`);
    process.exit(1);
  } catch (e) {
    console.error(`推送闸门出错：${e.message}`);
    process.exit(1);
  }
}
