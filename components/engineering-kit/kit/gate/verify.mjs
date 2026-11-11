// 推送前核对：git pre-push 钩子与 Claude 推送钩子共用。业务含义：本次改动含源文件时，必须同时满足
//   静态检查通过（测试先行、注释）、测试记录通过、复审记录通过，且两份记录都对应当前代码树和当前基准提交（基线）。
//   复审流程为 pr（modules.gate.reviewFlow）时不要求复审记录：复审在 CI 通过后针对 PR 最终提交进行，由 merge.mjs 核对。
// 闸门范围的口径见 lib.mjs 的 gateScope：本次改动中去掉文档的部分，判定文档用基准提交上配置的 reviewIgnore，
//   项目配置、豁免表和 scripts/engineering/** 永远在范围内；基准分支设置取默认主干上的配置（lib.mjs 的 loadConfig），
//   判定策略（reviewIgnore、reviewFlow 等）取基准提交上的配置，工作区写的值与生效值不同时给提示行。只改文档的推送直接放行。
// 范围内有未提交改动、基准分支解析不了时拒绝。失败时列出阻塞原因，退出码 1。
// git pre-push 钩子带 --pre-push 调用：另从 stdin 读取实际要推送的引用，分支推送的提交必须是当前 HEAD
//   （闸门核对的就是它）或已在基准分支里；标签推送不查引用，但工作区核对照常；只删除远端引用的推送直接放行。
// 用法：node scripts/engineering/gate/verify.mjs
//       node scripts/engineering/gate/verify.mjs --pre-push <远端名> <远端地址>   （由 pre-push 钩子调用，stdin 为推送的引用）
import fs from 'node:fs';
import { checkComments } from './check-comments.mjs';
import { checkTestFirst } from './check-test-first.mjs';
import {
  EMPTY_TREE,
  gateScope,
  git,
  isIgnoredDoc,
  isMain,
  newFiles,
  isSourceFile,
  loadConfig,
  loadExempt,
  allowedTopDirs,
  readRecord,
  repoRoot,
  resolveBase,
  treeHash,
  uncommittedInScope,
} from './lib.mjs';

/**
 * 新文件的位置检查：文档只能落在阶段目录、记录目录、索引或模板目录；新的顶层目录须在白名单内（以点开头的工具目录不查）。
 * 新文件包括改名而来的新路径（见 lib.mjs 的 newFiles）。不在允许位置、又没有豁免理由（exempt.newFiles）的新文件，推送时拦截。
 */
export function newFileProblems(root, config, exempt) {
  const out = [];
  const allowedDoc = (rel) =>
    rel === 'docs/README.md' ||
    rel.startsWith('docs/_templates/') ||
    config.layout.stages.some((s) => rel.startsWith(`docs/${s}/`)) ||
    config.hygiene.recordDirs.some((d) => rel.startsWith(`${d}/`));
  const allowedTop = allowedTopDirs(config.layout);
  const ex = exempt.newFiles || {};
  for (const f of newFiles(root, config.base)) {
    if (ex[f]) continue;
    if (f.startsWith('docs/') && !allowedDoc(f)) {
      out.push(`新文件不在允许的文档位置，且无理由：${f}（请放入阶段目录或记录目录，或在豁免表 newFiles 中写明理由）`);
    }
    const top = f.includes('/') ? f.split('/')[0] : null;
    if (top && !top.startsWith('.') && !allowedTop.has(top)) {
      out.push(`新文件所在顶层目录不在白名单：${f}（允许：${[...allowedTop].join('、')}）`);
    }
  }
  return out;
}

/**
 * 核对推送条件（工作区与记录）。返回 { ok, problems, note }。记录的基线（base）与当前基准提交不同、或旧记录没有基线时都不认。
 * 工作区配置的 base 或判定策略字段与生效值不同时，note 里多提示行（不算错误）。config 可由调用方传入（只读一次）。
 */
export function verify({ root, config = loadConfig(root) }) {
  const res = verifyWith(root, config);
  return { ...res, note: [...config.notes, res.note].filter(Boolean).join('\n') };
}

/** verify 的核对本身（配置由调用方读取）。 */
function verifyWith(root, config) {
  const exempt = loadExempt(root);
  const { baseRev, changed, scope, reviewIgnore } = gateScope(root, config);
  const sources = changed.filter((f) => isSourceFile(f, config) && !isIgnoredDoc(f, reviewIgnore));
  const newProblems = newFileProblems(root, config, exempt);
  // 范围 = 本次所有非文档的改动（源文件、闸门脚本、配置等）。只有文档类改动才可以不要记录。
  if (scope.length === 0) {
    return { ok: newProblems.length === 0, problems: newProblems, note: '本次只有文档类改动（reviewIgnore 之内），无需闸门记录' };
  }

  const problems = [
    ...newProblems,
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
  else if (tests.base !== baseRev) problems.push('测试记录的基线已变化（基准提交与跑闸门时不同，例如合入了新主干），请重跑闸门');
  else if (tests.treeHash !== hash) problems.push('测试记录与当前代码不一致（代码已变化），请重跑闸门');

  if (config.reviewFlow === 'pr') return { ok: problems.length === 0, problems, note: '' };
  const review = readRecord(root, 'review.json');
  if (!review) problems.push('没有复审记录：复审通过后运行 review.mjs pass --reviewer ... --report ...');
  else if (review.verdict !== 'pass') problems.push('最近一次复审结论不是通过');
  else if (review.base !== baseRev) problems.push('复审记录的基线已变化（基准提交与复审时不同），请重跑闸门并重新复审');
  else if (review.treeHash !== hash) problems.push('复审记录与当前代码不一致（复审之后代码变了），需重跑闸门并重新复审');

  return { ok: problems.length === 0, problems, note: '' };
}

/** 全零的对象名：pre-push 的 stdin 里表示“删除”（本地一侧）或“远端还没有”（远端一侧）。 */
const ZERO_SHA = /^0+$/;

/**
 * 解析 pre-push 钩子的 stdin：每行 `<本地 ref> <本地 sha> <远端 ref> <远端 sha>`。
 * 返回 [{ localRef, localSha, remoteRef, remoteSha }]；空行和格式不对的行跳过（兼容 CRLF）。
 */
export function parsePushUpdates(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 4) continue;
    const [localRef, localSha, remoteRef, remoteSha] = parts;
    out.push({ localRef, localSha, remoteRef, remoteSha });
  }
  return out;
}

/** 推送是否只删除远端引用（本地一侧全是零）：什么提交都不上传。 */
export function onlyDeletes(updates) {
  return updates.length > 0 && updates.every((u) => ZERO_SHA.test(u.localSha));
}

/**
 * 推送引用核对：闸门核对的是当前检出的 HEAD，所以分支推送（远端 ref 为 refs/heads/*、且不是删除）
 * 推上去的提交必须等于当前 HEAD，或者已经包含在基准分支里（已合并的提交）。标签推送与删除不在这里拦。
 * 返回问题列表（空数组表示通过）；需要基准分支时解析不了会抛错（失败不放行）。
 */
export function pushRefProblems(root, config, updates) {
  const head = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const headSha = head.ok ? head.out.trim() : null;
  let baseTip; // 只在需要时解析
  const problems = [];
  for (const u of updates) {
    if (ZERO_SHA.test(u.localSha) || !u.remoteRef.startsWith('refs/heads/')) continue;
    if (u.localSha === headSha) continue;
    if (baseTip === undefined) {
      const b = resolveBase(root, config.base);
      baseTip = b === EMPTY_TREE ? null : b;
    }
    if (baseTip && git(root, ['merge-base', '--is-ancestor', u.localSha, baseTip]).ok) continue;
    problems.push(
      `推送的提交 ${u.localSha.slice(0, 12)}（${u.localRef} → ${u.remoteRef}）不是当前检出的提交，也不在基准分支 ${baseTip || '（无）'} 里：` +
        `闸门只核对当前检出的 HEAD（${headSha ? headSha.slice(0, 12) : '尚无提交'}），请切到要推送的分支（或到检出该分支的工作树里）跑闸门、复审后再推送`,
    );
  }
  return problems;
}

/**
 * pre-push 钩子的核对：只删除远端引用时直接放行；否则先核对推送的引用，再做工作区核对（verify）。
 * stdin 是 git 传给钩子的推送引用文本。返回 { ok, problems, note }。
 */
export function verifyPush({ root, stdin }) {
  const updates = parsePushUpdates(stdin);
  if (onlyDeletes(updates)) return { ok: true, problems: [], note: '只删除远端引用，不上传提交，无需核对' };
  const config = loadConfig(root);
  const refProblems = pushRefProblems(root, config, updates);
  const res = verify({ root, config });
  const problems = [...refProblems, ...res.problems];
  return { ok: problems.length === 0, problems, note: res.note };
}

if (isMain(import.meta.url)) {
  try {
    const root = repoRoot();
    const res = process.argv.includes('--pre-push') ? verifyPush({ root, stdin: fs.readFileSync(0, 'utf8') }) : verify({ root });
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
