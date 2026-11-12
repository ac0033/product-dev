// 闸门漏洞回归测试（0.5.1）：独立审查与两轮复审复现的十类缺陷，每组用例对应一项；多数修复前应失败，少数是防止改坏的对照用例（如主干上没有配置时用工作区的值）。
// 业务含义：闸门是装进别的项目里的硬约束，任何能让分支“自己豁免自己”、让旧记录在新基线上继续有效、
// 或绕开推送核对的路径，都会让闸门形同虚设。这里在临时 git 仓库里跑真实流程复现每一条。
//   1. 分支改自己的 reviewIgnore 让闸门范围变空        2. 合入新主干后旧的测试与复审记录仍被接受
//   3. git push origin 别的分支 绕过 pre-push 钩子       4. 复审报告的结论判定太窄或误判
//   5. 子模块指针不进树哈希                            6. 测试产物导致“运行期间代码变化”时提示语误导
//   7. git mv 进非白名单目录不被新文件位置检查拦截   8. 分支把 modules.gate.base 指向自己让范围变空
//   9. 判定策略（reviewFlow、reviewers、reviewMinChars、reviewKeyword）取自被审分支自己的配置
//  10. 结论标题写法按前缀匹配，“通过前需修复…”被当成通过；带句号的同行写法认不出
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runGate } from '../gate/gate.mjs';
import { loadConfig, readRecord, scopeFiles, treeHash, writeRecord } from '../gate/lib.mjs';
import { mergePr } from '../gate/merge.mjs';
import { recordReview } from '../gate/review.mjs';
import { verify } from '../gate/verify.mjs';
import { commitAll, featureRepo, git, reportFile, SRC_HEADER, TEST_CONFIG, tmpRepo, write, tmpDir } from './helpers.mjs';

const KIT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 合格的复审报告正文（不含结论），字数够。 */
const BODY = '范围：读了 dedup 函数、调用方和对应测试。\n发现：无高、中级问题。\n已逐条核对改动的 dedup 函数与测试用例，边界条件（空数组、重复项）均有覆盖，调用方也已核对。\n处置：无需处理。\n作者的验证：核对了作者给出的测试输出，没有重跑。\n';
/** 结论为通过的合格报告。 */
const PASS_REPORT = `${BODY}结论\n通过\n`;

/** 在功能分支上做一份能过静态检查的改动（源文件与引用它的测试一起改）。 */
function passingChange(root, tag = 'sorted') {
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return [...new Set(items)].sort(); // ${tag}\n}\n`);
  write(root, 'test/dedup.test.ts', `import { dedup } from '../src/dedup.ts';\nassert.ok(dedup, '${tag}');\n`);
}

/** 登记一次 pre-push 复审（pass，合格报告）。 */
function reviewPass(root, report = PASS_REPORT) {
  return recordReview({ root, verdict: 'pass', reviewer: 'general-purpose', reportPath: reportFile(report), summary: 's' });
}

// ---------- 1. 分支靠改自己的配置豁免自己 ----------

test('漏洞 1a：分支把 reviewIgnore 改成 ["**"]，配置文件和源文件仍在闸门范围内，推送核对不放行', () => {
  const root = featureRepo();
  passingChange(root);
  write(root, 'engineering.config.json', JSON.stringify({ ...TEST_CONFIG, reviewIgnore: ['**'] }, null, 2));
  commitAll(root, 'feat: 自我豁免');
  // 0.5.1 起 gateScope 只认 loadConfig 得出的生效值（reviewIgnore 取基准提交上的配置）
  const config = loadConfig(root);
  assert.deepEqual(config.reviewIgnore, TEST_CONFIG.reviewIgnore);
  const scope = scopeFiles(root, config);
  assert.ok(scope.includes('engineering.config.json'), `配置文件必须在范围内：${JSON.stringify(scope)}`);
  assert.ok(scope.includes('src/dedup.ts'), `判定范围用基准上的 reviewIgnore：${JSON.stringify(scope)}`);
  const res = verify({ root });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.ok(res.problems.some((p) => /没有测试记录/.test(p)), JSON.stringify(res.problems));
});

test('漏洞 1a：配置、豁免表、scripts/engineering/** 不受 reviewIgnore 影响，永远在范围内', () => {
  const root = featureRepo({ reviewIgnore: ['**/*.md', 'docs/**', 'scripts/**', '**/*.json'] });
  write(root, 'engineering.config.json', JSON.stringify({ ...TEST_CONFIG, reviewIgnore: ['**/*.md', 'docs/**', 'scripts/**', '**/*.json'], lockMaxAgeMinutes: 30 }, null, 2));
  write(root, 'scripts/engineering/exempt.json', JSON.stringify({ testFirst: {}, comments: {}, newFiles: {} }));
  write(root, 'scripts/engineering/gate/extra.mjs', '// 闸门脚本：被改动后必须进入闸门范围。\nexport const x = 1;\n');
  write(root, 'scripts/other/tool.json', '{}\n');
  const scope = scopeFiles(root, loadConfig(root));
  for (const f of ['engineering.config.json', 'scripts/engineering/exempt.json', 'scripts/engineering/gate/extra.mjs']) {
    assert.ok(scope.includes(f), `${f} 应在范围内：${JSON.stringify(scope)}`);
  }
  assert.ok(!scope.includes('scripts/other/tool.json'), '其他文件照常按 reviewIgnore 排除');
});

test('漏洞 1b：判定范围用基准提交上的 reviewIgnore；基准上没有配置（首次安装）时才用工作区的', () => {
  // 基准上有配置：工作区把 src/** 加进 reviewIgnore 不生效
  const root = featureRepo();
  write(root, 'engineering.config.json', JSON.stringify({ ...TEST_CONFIG, reviewIgnore: ['**/*.md', 'docs/**', 'src/**', 'test/**'] }, null, 2));
  passingChange(root);
  const res = runGate({ root });
  assert.equal(res.ok, true, res.messages.join('\n'));
  const scope = scopeFiles(root, loadConfig(root));
  assert.ok(scope.includes('src/dedup.ts'), JSON.stringify(scope));
  assert.equal(res.record.treeHash, treeHash(root, scope), 'gate 与 scopeFiles 同一口径');

  // 基准上没有配置：用工作区的 reviewIgnore
  const fresh = tmpRepo();
  write(fresh, 'README.md', '# 说明\n');
  commitAll(fresh, 'base');
  git(fresh, ['checkout', '-q', '-b', 'install']);
  write(fresh, 'engineering.config.json', JSON.stringify({ ...TEST_CONFIG, reviewIgnore: ['**/*.md', 'docs/**', 'notes/**'] }, null, 2));
  write(fresh, 'notes/a.txt', '笔记\n');
  const s2 = scopeFiles(fresh, { ...TEST_CONFIG, reviewIgnore: ['**/*.md', 'docs/**', 'notes/**'] });
  assert.deepEqual(s2, ['engineering.config.json']);
});

test('漏洞 1b：review.mjs 与 gate.mjs 同一口径（工作区改 reviewIgnore 不能让复审记录变成“只改文档”）', () => {
  const root = featureRepo();
  write(root, 'engineering.config.json', JSON.stringify({ ...TEST_CONFIG, reviewIgnore: ['**'] }, null, 2));
  passingChange(root);
  commitAll(root, 'feat');
  const g = runGate({ root });
  assert.equal(g.ok, true, g.messages.join('\n'));
  const r = reviewPass(root);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.record.docsOnly, false);
  assert.equal(r.record.treeHash, g.record.treeHash);
});

/** 假的 gh：pr view 返回给定文件列表的打开 PR（CI 全过），其余命令成功。 */
function fakeGh(files, head = 'a'.repeat(40)) {
  const calls = [];
  const view = {
    state: 'OPEN',
    headRefOid: head,
    statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    files: files.map((p) => ({ path: p })),
  };
  const gh = (args) => {
    calls.push(args);
    return { status: 0, stdout: args[1] === 'view' ? JSON.stringify(view) : '', stderr: '' };
  };
  gh.calls = calls;
  return gh;
}

test('漏洞 1c：merge.mjs 判断“只改文档”用基准上的 reviewIgnore；含配置文件的 PR 不算只改文档', () => {
  // 0.6.0 起“只改文档”按本地的基准提交到 PR 最终提交的差异判定（不再用 gh 的文件列表），所以每种 PR 都在临时仓库里真的提交出来
  const root = featureRepo({ reviewFlow: 'pr' });
  /** 从主干开一个分支、写入给定文件并提交，返回提交号（作为 PR 的最终提交）。 */
  const prCommit = (branch, files) => {
    git(root, ['checkout', '-q', '-b', branch, 'main']);
    for (const [rel, text] of Object.entries(files)) write(root, rel, text);
    commitAll(root, branch);
    return git(root, ['rev-parse', 'HEAD']).trim();
  };
  // 工作区把 reviewIgnore 改成 **（不提交），PR 提交里只改一个源文件：合并入口不能因工作区的配置跳过审查
  const selfIgnore = JSON.stringify({ ...TEST_CONFIG, reviewFlow: 'pr', reviewIgnore: ['**'] }, null, 2);
  const h1 = prCommit('p1', { 'src/dedup.ts': `${SRC_HEADER}export const x = 1;\n` });
  write(root, 'engineering.config.json', selfIgnore);
  const res = mergePr({ root, pr: '7', gh: fakeGh(['src/dedup.ts'], h1) });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.ok(res.problems.some((p) => p.includes('缺少代码复审记录')), res.problems.join('\n'));
  git(root, ['checkout', '-q', '--', 'engineering.config.json']);

  const h2 = prCommit('p2', { 'README.md': '# 说明\n', 'engineering.config.json': selfIgnore });
  const res2 = mergePr({ root, pr: '7', gh: fakeGh(['README.md', 'engineering.config.json'], h2) });
  assert.equal(res2.ok, false, '含配置文件的 PR 不算只改文档');
  assert.ok(res2.problems.some((p) => p.includes('缺少代码复审记录')), res2.problems.join('\n'));

  const h3 = prCommit('p3', { 'README.md': '# 说明\n', 'docs/04-开发/a.md': '说明\n' });
  assert.equal(mergePr({ root, pr: '7', gh: fakeGh(['README.md', 'docs/04-开发/a.md'], h3) }).ok, true, '真正只改文档的 PR 仍按分档不审');
});

// ---------- 2. 基线变了旧记录仍有效 ----------

/** 功能分支上完整走一遍闸门与复审并提交，返回仓库。 */
function verifiedBranch() {
  const root = featureRepo();
  passingChange(root);
  commitAll(root, 'feat');
  assert.equal(runGate({ root }).ok, true);
  assert.equal(reviewPass(root).ok, true);
  assert.equal(verify({ root }).ok, true, JSON.stringify(verify({ root })));
  return root;
}

/** 主干前进一个提交后合入功能分支（树哈希只含改动文件，所以不变）。 */
function advanceMainAndMerge(root) {
  git(root, ['checkout', '-q', 'main']);
  write(root, 'pass2.mjs', 'process.exit(0);\n');
  commitAll(root, 'main 前进');
  git(root, ['checkout', '-q', 'feat']);
  git(root, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'merge', '-q', '--no-edit', 'main']);
}

test('漏洞 2：合入新主干后，旧的测试与复审记录作废，提示“基线已变化”', () => {
  const root = verifiedBranch();
  const before = readRecord(root, 'tests.json');
  advanceMainAndMerge(root);
  assert.equal(treeHash(root, scopeFiles(root, TEST_CONFIG)), before.treeHash, '前提：树哈希确实没变');
  const res = verify({ root });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.ok(res.problems.some((p) => /基线已变化/.test(p)), res.problems.join('\n'));
  // 复审登记也要核对测试记录的基线
  const r = reviewPass(root);
  assert.equal(r.ok, false, r.message);
  assert.match(r.message, /基线已变化/);
  // 重跑闸门、重新复审后恢复
  assert.equal(runGate({ root }).ok, true);
  assert.equal(reviewPass(root).ok, true);
  assert.equal(verify({ root }).ok, true, JSON.stringify(verify({ root })));
});

test('漏洞 2：记录里写入基准提交号；旧记录没有这个字段时按不一致处理', () => {
  const root = verifiedBranch();
  const mb = git(root, ['merge-base', 'main', 'HEAD']).trim();
  assert.equal(readRecord(root, 'tests.json').base, mb);
  assert.equal(readRecord(root, 'review.json').base, mb);
  const old = readRecord(root, 'tests.json');
  delete old.base;
  writeRecord(root, 'tests.json', old);
  const res = verify({ root });
  assert.equal(res.ok, false);
  assert.ok(res.problems.some((p) => /基线已变化/.test(p)), res.problems.join('\n'));
});

// ---------- 3. pre-push 钩子不看实际推送的提交 ----------

/** 运行 git，返回 { status, out }（不抛错，推送被钩子拒绝时要看输出）。 */
function gitTry(cwd, args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

/** pushRepo 的模板（本文件第一次用到时建一次）：{ root, remote }。 */
let pushTemplate = null;

/**
 * 装好闸门脚本与 pre-push 钩子、带一个裸远端的仓库：main 已推送；当前在 feat 上，feat 的改动已过闸门与复审并提交。
 * 另有分支 other：在 main 上加了一个没过闸门的提交。
 * 建这样一个仓库要跑一次带钩子的推送、一次闸门和一次复审登记（Windows 上约 5 秒），所以只建一次模板，
 * 每个用例复制一份（仓库与远端都复制，远端地址改指向副本），用例之间互不影响。
 */
function pushRepo() {
  if (!pushTemplate) pushTemplate = buildPushRepo();
  const root = tmpDir('ekit-push-');
  const remote = tmpDir('ekit-remote-');
  fs.cpSync(pushTemplate.root, root, { recursive: true });
  fs.cpSync(pushTemplate.remote, remote, { recursive: true });
  git(root, ['remote', 'set-url', 'origin', remote]);
  return root;
}

/** 真正建出 pushRepo 描述的仓库，返回 { root, remote }。 */
function buildPushRepo() {
  const root = featureRepo();
  git(root, ['checkout', '-q', 'main']);
  const gateDir = path.join(root, 'scripts', 'engineering', 'gate');
  fs.mkdirSync(gateDir, { recursive: true });
  for (const f of fs.readdirSync(path.join(KIT, 'gate'))) fs.copyFileSync(path.join(KIT, 'gate', f), path.join(gateDir, f));
  commitAll(root, '安装闸门');
  const hook = path.join(root, '.git', 'hooks', 'pre-push');
  fs.copyFileSync(path.join(KIT, 'hooks', 'pre-push.sh'), hook);
  fs.chmodSync(hook, 0o755);
  const remote = tmpDir('ekit-remote-');
  git(remote, ['init', '-q', '--bare']);
  git(root, ['remote', 'add', 'origin', remote]);
  const first = gitTry(root, ['push', '-q', 'origin', 'main']);
  assert.equal(first.status, 0, first.out);

  git(root, ['checkout', '-q', '-b', 'other']);
  write(root, 'src/dedup.ts', 'export function dedup(a) { return a; }\n'); // 没有头注释、没有测试：过不了闸门
  commitAll(root, '未过闸门的提交');
  git(root, ['checkout', '-q', 'feat']);
  git(root, ['rebase', '-q', 'main']);
  passingChange(root);
  commitAll(root, 'feat');
  assert.equal(runGate({ root }).ok, true);
  assert.equal(reviewPass(root).ok, true);
  return { root, remote };
}

test('漏洞 3：在已过闸门的 feat 上 git push origin other（未过闸门的分支）被 pre-push 钩子拒绝', () => {
  const root = pushRepo();
  const bad = gitTry(root, ['push', 'origin', 'other']);
  assert.notEqual(bad.status, 0, `推送别的分支应被拒绝：${bad.out}`);
  assert.match(bad.out, /不是当前检出的提交/);
  const sneaky = gitTry(root, ['push', 'origin', 'other:refs/heads/feat']);
  assert.notEqual(sneaky.status, 0, `把别的提交推到当前分支名也要拒绝：${sneaky.out}`);
  const ok = gitTry(root, ['push', 'origin', 'feat']);
  assert.equal(ok.status, 0, ok.out);
});

test('漏洞 3：已合并进基准分支的提交、标签推送、删除远端分支放行', () => {
  const root = pushRepo();
  git(root, ['branch', 'old-main', 'main']);
  const merged = gitTry(root, ['push', 'origin', 'old-main']);
  assert.equal(merged.status, 0, `已在基准分支里的提交应放行：${merged.out}`);
  git(root, ['tag', 'v-test', 'other']);
  const tag = gitTry(root, ['push', 'origin', 'v-test']);
  assert.equal(tag.status, 0, `标签推送放行：${tag.out}`);
  const del = gitTry(root, ['push', 'origin', '--delete', 'old-main']);
  assert.equal(del.status, 0, `删除远端分支放行：${del.out}`);
});

test('漏洞 3：推送引用的判定逻辑可单独测试（解析 stdin、分支/标签/删除）', async () => {
  const { parsePushUpdates, pushRefProblems } = await import('../gate/verify.mjs');
  assert.equal(typeof parsePushUpdates, 'function');
  const root = featureRepo();
  passingChange(root);
  commitAll(root, 'feat');
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const main = git(root, ['rev-parse', 'main']).trim();
  const zero = '0'.repeat(40);
  git(root, ['checkout', '-q', '-b', 'side', 'main']);
  write(root, 'x.txt', 'x\n');
  commitAll(root, 'side');
  const side = git(root, ['rev-parse', 'HEAD']).trim();
  git(root, ['checkout', '-q', 'feat']);
  const updates = parsePushUpdates(
    `refs/heads/feat ${head} refs/heads/feat ${zero}\r\nrefs/heads/side ${side} refs/heads/side ${zero}\n` +
      `refs/tags/t ${side} refs/tags/t ${zero}\n(delete) ${zero} refs/heads/gone ${main}\nrefs/heads/main ${main} refs/heads/main ${zero}\n\n`,
  );
  assert.equal(updates.length, 5);
  const problems = pushRefProblems(root, TEST_CONFIG, updates);
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /refs\/heads\/side/);
});

test('漏洞 3：Claude 推送钩子调用 verify 的方式不受影响（不带参数、不读 stdin 也能核对）', () => {
  const root = featureRepo();
  passingChange(root);
  commitAll(root, 'feat');
  const r = spawnSync(process.execPath, [path.join(KIT, 'hooks', 'pre-bash.mjs')], {
    input: JSON.stringify({ tool_input: { command: 'git push origin feat' }, cwd: root }),
    encoding: 'utf8',
  });
  assert.equal(r.status, 2, `没有闸门记录时 Claude 钩子应拒绝：${r.stderr}`);
  assert.match(r.stderr, /没有测试记录/);
});

// ---------- 4. 复审结论判定 ----------

/** 准备好通过的测试记录的仓库（复审登记的前提）。 */
function gatedRepo(config) {
  const root = featureRepo(config);
  passingChange(root);
  assert.equal(runGate({ root }).ok, true);
  return root;
}

test('漏洞 4：“结论：**未**通过”“结论：有 2 个高级问题，不通过”不能登记为 pass', () => {
  for (const line of ['结论：**未**通过\n', '结论：有 2 个高级问题，不通过\n', '## 结论\n\n未通过：H1 未修复。\n']) {
    const root = gatedRepo();
    const r = reviewPass(root, `${BODY}${line}`);
    assert.equal(r.ok, false, `${line} → ${r.message}`);
  }
});

test('漏洞 4：“结论：未通过的问题已修复，通过”是通过；报告模板的“## 结论”下一行写法照常可用', () => {
  // 0.6.0 起报告模板的结论一节改成不带括号的示例写法（二选一）；带括号的占位写法“通过（或 不通过）”不再认作通过
  for (const line of ['结论：未通过的问题已修复，通过\n', '## 结论\n\n通过。一句话理由；无高、中级问题。\n', '> **结论**：**通过**\n', '结论：通过\n']) {
    const root = gatedRepo();
    const r = reviewPass(root, `${BODY}${line}`);
    assert.equal(r.ok, true, `${line} → ${r.message}`);
  }
  const placeholder = reviewPass(gatedRepo(), `${BODY}## 结论\n\n通过（或 不通过）。一句话理由；无高、中级问题。\n`);
  assert.equal(placeholder.ok, false, placeholder.message);
  assert.match(placeholder.message, /括号/);
});

test('漏洞 4：登记 fail 要求结论是不通过；找不到明确结论或前后矛盾时拒绝并提示写法', () => {
  const root = gatedRepo();
  const f = recordReview({ root, verdict: 'fail', reviewer: 'general-purpose', reportPath: reportFile(PASS_REPORT), summary: 's' });
  assert.equal(f.ok, false, f.message);
  assert.match(f.message, /结论/);
  const f2 = recordReview({ root, verdict: 'fail', reviewer: 'general-purpose', reportPath: reportFile(`${BODY}结论：有高级问题，不通过\n`), summary: 's' });
  assert.equal(f2.ok, true, f2.message);
  const none = reviewPass(root, `${BODY}结论部分见上面的发现表，整体看起来没有问题。\n`);
  assert.equal(none.ok, false, none.message);
  assert.match(none.message, /结论：通过/, '提示正确写法');
  const both = reviewPass(root, `${BODY}结论：通过\n补充说明若干。\n## 结论\n不通过\n`);
  assert.equal(both.ok, false, both.message);
});

test('漏洞 4：reviewKeyword 可配置，换了关键词也按同样两种写法判定', () => {
  const root = gatedRepo({ reviewKeyword: '评审意见' });
  assert.equal(reviewPass(root, `${BODY}评审意见：通过\n`).ok, true);
  assert.equal(reviewPass(root, `${BODY}评审意见：不通过\n`).ok, false);
  assert.equal(reviewPass(root, `${BODY}结论：通过\n`).ok, false, '没有配置的关键词时不认');
});

// ---------- 5. 子模块指针 ----------

test('漏洞 5：子模块指针计入树哈希（指向不同提交时哈希不同，且不等同于已删除）', () => {
  const sub = tmpRepo();
  write(sub, 'a.txt', 'v1\n');
  commitAll(sub, 'v1');
  const root = featureRepo();
  git(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor-sub']);
  commitAll(root, 'add submodule');
  const h1 = treeHash(root, ['vendor-sub']);
  const subDir = path.join(root, 'vendor-sub');
  write(subDir, 'a.txt', 'v2\n');
  commitAll(subDir, 'v2');
  const h2 = treeHash(root, ['vendor-sub']);
  assert.notEqual(h1, h2, '子模块指向的提交变了，哈希必须变');
  // 子模块目录被真正删掉（记为已删除）时，哈希与指向某个提交时不同
  fs.rmSync(subDir, { recursive: true, force: true });
  assert.notEqual(treeHash(root, ['vendor-sub']), h2);
});

// ---------- 6. 测试产物 ----------

test('漏洞 6：测试命令生成未被忽略的文件时仍判不通过，但提示列出文件名并建议加入 .gitignore', () => {
  const root = featureRepo({ testCommand: 'node gen.mjs' });
  passingChange(root);
  write(root, 'gen.mjs', "import fs from 'node:fs';\nfs.writeFileSync('coverage-out.txt', 'x\\n');\n");
  const res = runGate({ root });
  assert.equal(res.ok, false, res.messages.join('\n'));
  assert.equal(res.record.changedDuringRun, true);
  const hint = res.messages.find((m) => m.includes('coverage-out.txt'));
  assert.ok(hint && hint.includes('.gitignore'), res.messages.join('\n'));
});

test('漏洞 6：测试命令改了已有文件时仍是原来的“代码变化”提示，不建议 .gitignore', () => {
  const root = featureRepo({ testCommand: 'node touch.mjs' });
  passingChange(root);
  write(root, 'touch.mjs', "import fs from 'node:fs';\nfs.appendFileSync('src/dedup.ts', '// x\\n');\n");
  const res = runGate({ root });
  assert.equal(res.ok, false);
  assert.ok(res.messages.some((m) => /运行期间代码发生了变化/.test(m)), res.messages.join('\n'));
  assert.ok(!res.messages.some((m) => m.includes('.gitignore')), res.messages.join('\n'));
});

// ---------- 7. 改名绕过新文件位置检查 ----------

test('漏洞 7：git mv 进非白名单目录（已提交或只暂存）都按新文件检查', () => {
  const root = featureRepo();
  git(root, ['mv', 'pass.mjs', 'junk-pass.mjs']);
  fs.mkdirSync(path.join(root, 'junk'));
  git(root, ['mv', 'fail.mjs', 'junk/fail.mjs']);
  const staged = verify({ root });
  assert.ok(staged.problems.some((p) => /顶层目录不在白名单.*junk\/fail\.mjs/.test(p)), staged.problems.join('\n'));
  commitAll(root, 'mv');
  const committed = verify({ root });
  assert.ok(committed.problems.some((p) => /顶层目录不在白名单.*junk\/fail\.mjs/.test(p)), committed.problems.join('\n'));
});

test('漏洞 7：文档改名到不允许的位置也被拦', () => {
  const root = featureRepo();
  git(root, ['checkout', '-q', 'main']);
  write(root, 'docs/04-开发/契约.md', '状态：draft\n');
  commitAll(root, 'doc');
  git(root, ['checkout', '-q', 'feat']);
  git(root, ['rebase', '-q', 'main']);
  git(root, ['mv', 'docs/04-开发/契约.md', 'docs/random.md']);
  commitAll(root, 'mv doc');
  const res = verify({ root });
  assert.ok(res.problems.some((p) => /允许的文档位置.*docs\/random\.md/.test(p)), res.problems.join('\n'));
});

// ---------- 8. 分支改 modules.gate.base 让范围变空 ----------

test('漏洞 8a：分支把 base 改成指向自己、加一个无测试的源文件并提交，推送核对仍不通过，并提示以默认主干上的设置为准', () => {
  const root = featureRepo();
  write(root, 'engineering.config.json', JSON.stringify({ ...TEST_CONFIG, base: 'feat' }, null, 2));
  write(root, 'src/rank.ts', `${SRC_HEADER}/** 排序。 */\nexport function rank(x: number) {\n  return x * 2;\n}\n`);
  commitAll(root, 'feat: 自己当基准');
  const res = verify({ root });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.ok(res.problems.some((p) => /没有引用它的测试|没有测试记录/.test(p)), res.problems.join('\n'));
  assert.match(res.note, /默认主干/);
  assert.equal(loadConfig(root).base, 'main', '生效的基准设置取默认主干上的配置');
  const g = runGate({ root });
  assert.equal(g.ok, false);
  assert.ok(g.messages.some((m) => /默认主干/.test(m)), g.messages.join('\n'));
});

test('漏洞 8b：主干配置的 base 是 dev 时，功能分支照常按 dev 计算范围（即使 dev 上的配置写的是别的）', () => {
  const root = tmpRepo();
  write(root, 'engineering.config.json', JSON.stringify({ ...TEST_CONFIG, base: 'dev' }, null, 2));
  write(root, 'README.md', '# 说明\n');
  commitAll(root, 'base');
  git(root, ['checkout', '-q', '-b', 'dev']);
  write(root, 'engineering.config.json', JSON.stringify({ ...TEST_CONFIG, base: 'main' }, null, 2));
  write(root, 'dev.txt', 'dev\n');
  commitAll(root, 'dev');
  git(root, ['checkout', '-q', '-b', 'feat']);
  write(root, 'feat.txt', 'feat\n');
  const config = loadConfig(root);
  assert.equal(config.base, 'dev');
  assert.deepEqual(scopeFiles(root, config), ['feat.txt']);
});

test('漏洞 8c：默认主干上没有配置文件时，用工作区配置的 base', () => {
  const root = tmpRepo();
  write(root, 'README.md', '# 说明\n');
  commitAll(root, 'base');
  git(root, ['checkout', '-q', '-b', 'dev']);
  write(root, 'dev.txt', 'dev\n');
  commitAll(root, 'dev');
  git(root, ['checkout', '-q', '-b', 'install']);
  write(root, 'engineering.config.json', JSON.stringify({ ...TEST_CONFIG, base: 'dev' }, null, 2));
  write(root, 'a.txt', 'a\n');
  const config = loadConfig(root);
  assert.equal(config.base, 'dev');
  assert.deepEqual(scopeFiles(root, config), ['a.txt', 'engineering.config.json']);
});

test('漏洞 8：默认主干上的配置不合法时报错，不放行', () => {
  const root = tmpRepo();
  write(root, 'engineering.config.json', '{ 不是 JSON');
  commitAll(root, 'base');
  git(root, ['checkout', '-q', '-b', 'feat']);
  write(root, 'engineering.config.json', JSON.stringify(TEST_CONFIG, null, 2));
  assert.throws(() => loadConfig(root), /默认主干/);
});

// ---------- 9. 判定策略字段取自被审分支自己的配置 ----------

test('漏洞 9-1：pre-push 项目的功能分支把 reviewFlow 改成 pr，推送核对仍要求复审记录', () => {
  const root = featureRepo();
  write(root, 'engineering.config.json', JSON.stringify({ ...TEST_CONFIG, reviewFlow: 'pr' }, null, 2));
  passingChange(root);
  commitAll(root, 'feat: 改成 pr 流程');
  assert.equal(runGate({ root }).ok, true);
  assert.equal(loadConfig(root).reviewFlow, 'pre-push', '判定策略取基准提交上的配置');
  const res = verify({ root });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.ok(res.problems.some((p) => /没有复审记录/.test(p)), res.problems.join('\n'));
  assert.match(res.note, /reviewFlow/, '工作区值与生效值不同时给一行提示');
});

test('漏洞 9-2：分支改 reviewKeyword / reviewers / reviewMinChars 后，登记仍按基准上的值判定', () => {
  const root = featureRepo();
  write(root, 'engineering.config.json', JSON.stringify({ ...TEST_CONFIG, reviewKeyword: '处置', reviewers: ['me-myself'], reviewMinChars: 5 }, null, 2));
  passingChange(root);
  assert.equal(runGate({ root }).ok, true);
  const bad = `${BODY}处置：通过\n## 结论\n不通过\n`;
  const r1 = recordReview({ root, verdict: 'pass', reviewer: 'general-purpose', reportPath: reportFile(bad), summary: 's' });
  assert.equal(r1.ok, false, `关键词仍是“结论”，结论为不通过：${r1.message}`);
  const r2 = recordReview({ root, verdict: 'pass', reviewer: 'me-myself', reportPath: reportFile(PASS_REPORT), summary: 's' });
  assert.equal(r2.ok, false, r2.message);
  assert.match(r2.message, /复审者/);
  const r3 = recordReview({ root, verdict: 'pass', reviewer: 'general-purpose', reportPath: reportFile('结论：通过\n'), summary: 's' });
  assert.equal(r3.ok, false, r3.message);
  assert.match(r3.message, /不少于 60/);
});

test('漏洞 9-3：基准上没有配置时，判定策略用工作区的值', () => {
  const root = tmpRepo();
  write(root, 'README.md', '# 说明\n');
  commitAll(root, 'base');
  git(root, ['checkout', '-q', '-b', 'install']);
  write(root, 'engineering.config.json', JSON.stringify({ ...TEST_CONFIG, reviewKeyword: '评审意见', reviewFlow: 'pr', reviewMinChars: 10 }, null, 2));
  const c = loadConfig(root);
  assert.equal(c.reviewKeyword, '评审意见');
  assert.equal(c.reviewFlow, 'pr');
  assert.equal(c.reviewMinChars, 10);
});

test('漏洞 9-4：主干上合法地把 reviewFlow 改成 pr 之后，功能分支按 pr 走', () => {
  const root = featureRepo();
  git(root, ['checkout', '-q', 'main']);
  write(root, 'engineering.config.json', JSON.stringify({ ...TEST_CONFIG, reviewFlow: 'pr' }, null, 2));
  commitAll(root, 'main: 改用 pr 流程');
  git(root, ['checkout', '-q', 'feat']);
  git(root, ['rebase', '-q', 'main']);
  passingChange(root);
  commitAll(root, 'feat');
  assert.equal(runGate({ root }).ok, true);
  assert.equal(loadConfig(root).reviewFlow, 'pr');
  const res = verify({ root });
  assert.equal(res.ok, true, JSON.stringify(res));
});

// ---------- 10. 结论判定：标题写法也必须整句恰好是结论词 ----------

test('漏洞 10：“## 结论”下一行只是以“通过”开头（通过前需修复…、通过与否取决于…）不算通过', () => {
  for (const tail of ['## 结论\n通过前需修复 H1、M2\n', '## 结论\n\n通过与否取决于 H1 的修复情况。\n', '## 结论\nPass\n']) {
    const root = gatedRepo();
    const r = reviewPass(root, `${BODY}${tail}`);
    assert.equal(r.ok, false, `${tail} → ${r.message}`);
  }
});

test('漏洞 10：带句号的写法都能认出：“结论：通过。无高、中级问题。”“## 结论 / 通过。理由”“## 结论 / 不通过。理由”', () => {
  const root = gatedRepo();
  // 0.6.0 起带括号的模板占位写法不认（见 mechanisms.test.mjs 的结论判定用例），这里换成模板的新写法
  for (const tail of ['结论：通过。无高、中级问题。\n', '## 结论\n通过。一句话理由；无高、中级问题。\n', '## 结论\n\n通过。一句话理由；高、中级问题的编号清单。\n']) {
    const r = reviewPass(root, `${BODY}${tail}`);
    assert.equal(r.ok, true, `${tail} → ${r.message}`);
  }
  const f = recordReview({ root, verdict: 'fail', reviewer: 'general-purpose', reportPath: reportFile(`${BODY}## 结论\n不通过。H1 未修复。\n`), summary: 's' });
  assert.equal(f.ok, true, f.message);
});
