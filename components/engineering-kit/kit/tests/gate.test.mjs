// 闸门行为测试：测试先行、注释、测试记录、复审记录、树哈希绑定与推送前核对。
// 每个用例都在临时 git 仓库里跑真实流程，不 mock git。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { checkComments } from '../gate/check-comments.mjs';
import { checkTestFirst, referencesFile } from '../gate/check-test-first.mjs';
import { acquireLock, changedFiles, loadConfig, readRecord, recordDir, scopeFiles, treeHash, writeRecord } from '../gate/lib.mjs';
import { runGate } from '../gate/gate.mjs';
import { branchDirName, recordReview } from '../gate/review.mjs';
import { newFileProblems, verify } from '../gate/verify.mjs';
import { commitAll, featureRepo, git, read, reportFile, SRC_HEADER, TEST_CONFIG, tmpRepo, trackTmp, write } from './helpers.mjs';

/** 测试直接使用测试配置对象（不经过 loadConfig 读文件）。 */
const cfg = { ...TEST_CONFIG };

/** 一个合格的复审报告：字数够、含“结论”、结论为通过。 */
const GOOD_REPORT = `发现：无高、中级问题。\n已逐条核对改动的 dedup 函数与测试用例，边界条件（空数组、重复项）均有覆盖。\n处置：无需处理。\n结论\n通过\n`;

test('测试先行：源文件改动时，引用它的测试也必须在本次改动里', () => {
  const root = featureRepo();
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return items;\n}\n`);
  const problems = checkTestFirst({ root, changed: changedFiles(root, 'main'), config: cfg, exempt: {} });
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /没有随改动一起改/);
});

test('测试先行：新源文件没有任何测试引用 → 报缺测试', () => {
  const root = featureRepo();
  write(root, 'src/rank.ts', `${SRC_HEADER}export function rank(x: number) {\n  return x * 2;\n}\n`);
  const problems = checkTestFirst({ root, changed: changedFiles(root, 'main'), config: cfg, exempt: {} });
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /没有引用它的测试/);
});

test('测试先行：源文件和测试一起改 → 通过', () => {
  const root = featureRepo();
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return [...new Set(items)].sort();\n}\n`);
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nassert.ok(dedup, 'sorted');\n");
  const problems = checkTestFirst({ root, changed: changedFiles(root, 'main'), config: cfg, exempt: {} });
  assert.equal(problems.length, 0);
});

test('测试先行：豁免表里的路径不检查', () => {
  const root = featureRepo();
  write(root, 'src/rank.ts', `${SRC_HEADER}export function rank(x: number) {\n  return x * 2;\n}\n`);
  const problems = checkTestFirst({
    root,
    changed: changedFiles(root, 'main'),
    config: cfg,
    exempt: { 'src/rank.ts': '临时：由集成测试覆盖，单元测试下一轮补' },
  });
  assert.equal(problems.length, 0);
});

test('注释：缺文件头注释 → 报错', () => {
  const root = featureRepo();
  write(root, 'src/dedup.ts', 'export function dedup(items: string[]) {\n  return items;\n}\n');
  const problems = checkComments({ root, files: ['src/dedup.ts'], config: cfg, exempt: {} });
  assert.ok(problems.some((p) => /文件头注释/.test(p.message)), JSON.stringify(problems));
});

test('注释：导出函数前没有注释 → 报错；interface 与 type 不要求', () => {
  const root = featureRepo();
  write(
    root,
    'src/dedup.ts',
    `${SRC_HEADER}export interface Item { id: string }\nexport type Id = string;\nexport function dedup(items: Item[]) {\n  return items;\n}\n`,
  );
  const problems = checkComments({ root, files: ['src/dedup.ts'], config: cfg, exempt: {} });
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.match(problems[0].message, /导出.*没有注释/);
});

test('注释：导出前紧挨注释（中间可有装饰器）→ 通过', () => {
  const root = featureRepo();
  write(
    root,
    'src/dedup.ts',
    `${SRC_HEADER}/** 按顺序去重。 */\nexport function dedup(items: string[]) {\n  return [...new Set(items)];\n}\n`,
  );
  const problems = checkComments({ root, files: ['src/dedup.ts'], config: cfg, exempt: {} });
  assert.equal(problems.length, 0, JSON.stringify(problems));
});

test('树哈希：只改文档不改变哈希；改源文件后哈希变化', () => {
  const root = featureRepo();
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return items;\n}\n`);
  const h1 = treeHash(root, scopeFiles(root, cfg));
  write(root, 'docs/note.md', '说明文字\n');
  const h2 = treeHash(root, scopeFiles(root, cfg));
  assert.equal(h1, h2, '文档改动不应影响代码树哈希');
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return items.slice();\n}\n`);
  const h3 = treeHash(root, scopeFiles(root, cfg));
  assert.notEqual(h1, h3);
});

test('测试记录：测试通过后写入记录，哈希与当前树一致', () => {
  const root = featureRepo();
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return [...new Set(items)].sort();\n}\n`);
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nassert.ok(dedup, 'sorted');\n");
  const result = runGate({ root });
  assert.equal(result.ok, true, result.messages.join('\n'));
  assert.equal(result.record.passed, true);
  assert.equal(result.record.treeHash, treeHash(root, scopeFiles(root, cfg)));
});

test('测试记录：测试失败 → 记录 passed=false，闸门不通过', () => {
  const root = featureRepo({ testCommand: 'node fail.mjs' });
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return [...new Set(items)].sort();\n}\n`);
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nassert.ok(dedup, 'sorted');\n");
  const result = runGate({ root });
  assert.equal(result.ok, false);
  assert.equal(result.record.passed, false);
});

test('复审记录：报告太短 → 拒绝', () => {
  const root = featureRepo();
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return [...new Set(items)].sort();\n}\n`);
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nassert.ok(dedup, 'sorted');\n");
  assert.equal(runGate({ root }).ok, true);
  const rp = reportFile('结论\n通过\n');
  const r = recordReview({ root, verdict: 'pass', reviewer: 'feature-dev:code-reviewer', reportPath: rp, summary: 's' });
  assert.equal(r.ok, false);
  assert.match(r.message, /不少于/);
});

test('复审记录：复审者不在允许名单 → 拒绝', () => {
  const root = featureRepo();
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return [...new Set(items)].sort();\n}\n`);
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nassert.ok(dedup, 'sorted');\n");
  runGate({ root });
  const rp = reportFile(GOOD_REPORT);
  const r = recordReview({ root, verdict: 'pass', reviewer: 'me-myself', reportPath: rp, summary: 's' });
  assert.equal(r.ok, false);
  assert.match(r.message, /复审者/);
});

test('复审记录：报告结论写“不通过”却记 pass → 拒绝', () => {
  const root = featureRepo();
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return [...new Set(items)].sort();\n}\n`);
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nassert.ok(dedup, 'sorted');\n");
  runGate({ root });
  const rp = reportFile(GOOD_REPORT.replace('通过\n', '不通过\n'));
  const r = recordReview({ root, verdict: 'pass', reviewer: 'feature-dev:code-reviewer', reportPath: rp, summary: 's' });
  assert.equal(r.ok, false);
  assert.match(r.message, /不通过/);
});

test('复审记录：没有通过的测试记录时拒绝（先跑闸门）', () => {
  const root = featureRepo();
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return [...new Set(items)].sort();\n}\n`);
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nassert.ok(dedup, 'sorted');\n");
  const rp = reportFile(GOOD_REPORT);
  const r = recordReview({ root, verdict: 'pass', reviewer: 'feature-dev:code-reviewer', reportPath: rp, summary: 's' });
  assert.equal(r.ok, false);
  assert.match(r.message, /先运行闸门/);
});

test('推送前核对：完整流程通过；改源文件后作废；只改文档仍有效', () => {
  const root = featureRepo();
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return [...new Set(items)].sort();\n}\n`);
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nassert.ok(dedup, 'sorted');\n");
  assert.equal(runGate({ root }).ok, true);
  const rp = reportFile(GOOD_REPORT);
  assert.equal(recordReview({ root, verdict: 'pass', reviewer: 'feature-dev:code-reviewer', reportPath: rp, summary: 's' }).ok, true);
  commitAll(root, 'feat: dedup sorted');
  assert.equal(verify({ root }).ok, true, JSON.stringify(verify({ root })));

  write(root, 'docs/04-开发/note.md', '只改文档\n');
  assert.equal(verify({ root }).ok, true, '只改文档不应使复审失效');

  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return items;\n}\n`);
  const after = verify({ root });
  assert.equal(after.ok, false);
  assert.ok(after.problems.some((p) => /树已变化|记录与当前代码不一致|复审/.test(p)), JSON.stringify(after.problems));
});

test('推送前核对：没有源文件改动 → 直接通过', () => {
  const root = tmpRepo();
  write(root, 'engineering.config.json', JSON.stringify(TEST_CONFIG));
  write(root, 'README.md', '# 说明\n');
  commitAll(root, 'base');
  git(root, ['checkout', '-q', '-b', 'docs']);
  write(root, 'README.md', '# 说明（更新）\n');
  assert.equal(verify({ root }).ok, true);
  assert.equal(read(root, 'README.md').includes('更新'), true);
});

/** 在 featureRepo 上写入一个通过静态检查、测试引用正确的改动，测试脚本读取环境变量决定退出码。 */
function envRepo(config) {
  const root = featureRepo(config);
  write(root, 'check-env.mjs', 'process.exit(process.env.KIT_TEST_FLAG === "on" ? 0 : 5);\n');
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return [...new Set(items)].sort();\n}\n`);
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nassert.ok(dedup, 'sorted');\n");
  return root;
}

test('测试命令环境变量：配置的 testEnv 会传给测试命令（Python 等项目靠它设置 PYTHONPATH）', () => {
  const withEnv = runGate({ root: envRepo({ testCommand: 'node check-env.mjs', testEnv: { KIT_TEST_FLAG: 'on' } }) });
  assert.equal(withEnv.ok, true, withEnv.messages.join('\n'));
  const withoutEnv = runGate({ root: envRepo({ testCommand: 'node check-env.mjs' }) });
  assert.equal(withoutEnv.ok, false);
});

test('测试先行：Python 的 “from 包 import 模块” 写法也算引用', () => {
  const py = (text, src = 'pdf_translation/budget.py') => referencesFile(text, 'tests/test_budget.py', src);
  assert.equal(py('from pdf_translation import budget\n'), true);
  assert.equal(py('from pdf_translation import tools, budget\n'), true);
  assert.equal(py('from pdf_translation.budget import Budget\n'), true);
  assert.equal(py('from pdf_translation import budget_helpers\n'), false);
  assert.equal(referencesFile("import { x } from '../src/dedup.ts';\n", 'test/dedup.test.ts', 'src/dedup.ts'), true);
});

test('闸门：配置的 glob 一个文件都匹配不上（如 JS 项目用了默认的 .ts）时报错，不当作“尚无源码”放行', () => {
  const root = tmpRepo();
  write(root, 'engineering.config.json', JSON.stringify({ ...TEST_CONFIG, base: 'auto', testCommand: 'node -e "process.exit(9)"' }));
  write(root, 'lib/a.js', '// 示例模块：glob 没有匹配到的 JS 源码。\nexport const a = 1;\n');
  const res = runGate({ root });
  assert.equal(res.ok, false, res.messages.join('\n'));
  assert.ok(res.messages.some((m) => m.includes('layout.sourceGlobs')), res.messages.join('\n'));
  assert.equal(res.record, null);
});

test('闸门：只有套件脚本与配置的首次提交仍可通过（不被上一条误伤）', () => {
  const root = tmpRepo();
  write(root, 'engineering.config.json', JSON.stringify({ ...TEST_CONFIG, base: 'auto' }));
  write(root, 'scripts/engineering/gate/gate.mjs', '// 套件脚本\nexport const x = 1;\n');
  const res = runGate({ root });
  assert.equal(res.ok, true, res.messages.join('\n'));
});

test('推送核对与巡检的顶层目录白名单一致：testGlobs 推出的 test/ 目录，新文件不被推送核对拦截', () => {
  const root = featureRepo();
  write(root, 'test/other.test.ts', "import { dedup } from '../src/dedup.ts';\nassert.ok(dedup);\n");
  const config = loadConfig(root);
  const problems = newFileProblems(root, config, {});
  assert.deepEqual(problems.filter((p) => p.includes('顶层目录')), [], problems.join('\n'));
});

test('复审记录：“结论：**不通过**”“结论：未通过”也识别为不通过', () => {
  for (const verdictLine of ['结论：**不通过**\n', '结论：未通过\n']) {
    const root = featureRepo();
    write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return [...new Set(items)].sort();\n}\n`);
    write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nassert.ok(dedup, 'sorted');\n");
    runGate({ root });
    const rp = reportFile(`${GOOD_REPORT.replace('结论\n通过\n', '')}${verdictLine}`);
    const r = recordReview({ root, verdict: 'pass', reviewer: 'feature-dev:code-reviewer', reportPath: rp, summary: 's' });
    assert.equal(r.ok, false, verdictLine);
  }
});

test('测试先行：模块名必须是完整的导入文件名，user-service 不算引用了 user', () => {
  const ref = (text) => referencesFile(text, 'test/user.test.js', 'src/user.ts');
  assert.equal(ref("import { a } from '../src/user-service';"), false);
  assert.equal(ref("import { a } from '../src/user';"), true);
  assert.equal(ref("import { a } from '../src/user.ts';"), true);
  assert.equal(ref("const a = require('../src/user.js');"), true);
});

test('记录目录：各工作树各用自己的 git 目录，记录互不覆盖', () => {
  const root = featureRepo();
  const wt = trackTmp(`${root}-wt`);
  git(root, ['worktree', 'add', '-q', '-b', 'other', wt]);
  assert.notEqual(recordDir(root), recordDir(wt));
  writeRecord(root, 'tests.json', { who: 'main' });
  assert.equal(readRecord(wt, 'tests.json'), null);
});

test('全局锁：持锁进程已不存在（如 Ctrl+C）时直接清理重取；进程还在时拒绝', () => {
  const root = featureRepo();
  const lock = path.join(root, '.git', 'engineering-gate.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2 ** 22 + 12345 }));
  acquireLock(root)();
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
  assert.throws(() => acquireLock(root), /闸门锁被占用/);
  fs.rmSync(lock, { recursive: true });
});

test('注释：#! 解释器行不算文件头注释', () => {
  const root = tmpRepo();
  write(root, 'src/cli.ts', '#!/usr/bin/env node\nexport const a = 1;\n');
  const problems = checkComments({ root, files: ['src/cli.ts'], config: { ...cfg, commentMode: 'header' }, exempt: {} });
  assert.equal(problems.length, 1, JSON.stringify(problems));
});

/** 在 featureRepo 上做一份能过静态检查的改动（源文件与引用它的测试一起改）。 */
function passingChange(config) {
  const root = featureRepo(config);
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return [...new Set(items)].sort();\n}\n`);
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nassert.ok(dedup, 'sorted');\n");
  return root;
}

test('闸门输出：通过时列出测试先行和注释两项静态检查各查了几个文件，并写进测试记录', () => {
  const root = passingChange();
  write(root, 'src/types.ts', `${SRC_HEADER}interface Item { id: string }\n`);
  write(root, 'scripts/engineering/exempt.json', JSON.stringify({ testFirst: { 'src/legacy.ts': '历史代码，由集成测试覆盖' }, comments: { 'src/legacy.ts': '历史代码' } }));
  write(root, 'src/legacy.ts', 'export const legacy = 1;\n');
  const res = runGate({ root });
  assert.equal(res.ok, true, res.messages.join('\n'));
  const tf = res.messages.find((m) => m.startsWith('测试先行检查通过'));
  const cm = res.messages.find((m) => m.startsWith('注释检查通过'));
  assert.ok(tf && cm, res.messages.join('\n'));
  // 改动的源文件 3 个：dedup.ts 被检查，types.ts 没有可测的导出（无需测试），legacy.ts 在豁免表里
  assert.match(tf, /检查 1 个/);
  assert.match(tf, /豁免 1 个/);
  assert.match(tf, /无需测试 1 个/);
  assert.match(cm, /检查 2 个/);
  assert.match(cm, /豁免 1 个/);
  assert.ok(res.messages.indexOf(tf) < res.messages.findIndex((m) => m.startsWith('测试通过')), '静态检查结果排在测试结果之前');
  assert.deepEqual(res.record.staticChecks, { testFirst: { checked: 1, exempt: 1, skipped: 1 }, comments: { checked: 2, exempt: 1 } });
  assert.deepEqual(readRecord(root, 'tests.json').staticChecks, res.record.staticChecks);
});

test('闸门输出：没有改到源文件时两项静态检查都写明检查 0 个；静态检查不过时不出现“通过”行', () => {
  const root = featureRepo();
  write(root, 'docs/note.md', '只改文档\n');
  const res = runGate({ root });
  assert.equal(res.ok, true, res.messages.join('\n'));
  assert.ok(res.messages.some((m) => /^测试先行检查通过.*检查 0 个/.test(m)), res.messages.join('\n'));
  assert.ok(res.messages.some((m) => /^注释检查通过.*检查 0 个/.test(m)), res.messages.join('\n'));

  const bad = featureRepo();
  write(bad, 'src/dedup.ts', 'export function dedup(items: string[]) {\n  return items;\n}\n');
  const failed = runGate({ root: bad });
  assert.equal(failed.ok, false);
  assert.ok(!failed.messages.some((m) => /检查通过/.test(m)), failed.messages.join('\n'));
});

test('闸门输出：尚无源码与测试文件时也列出两项静态检查（各 0 个）', () => {
  const root = tmpRepo();
  write(root, 'engineering.config.json', JSON.stringify({ ...TEST_CONFIG, base: 'auto' }));
  const res = runGate({ root });
  assert.equal(res.ok, true, res.messages.join('\n'));
  assert.ok(res.messages.some((m) => /^测试先行检查通过.*检查 0 个/.test(m)), res.messages.join('\n'));
  assert.ok(res.messages.some((m) => /^注释检查通过.*检查 0 个/.test(m)), res.messages.join('\n'));
});

test('复审登记（pre-push）：记录分支名和 HEAD 提交号，报告副本与历史按分支分开', () => {
  const root = passingChange();
  commitAll(root, 'feat: dedup sorted');
  assert.equal(runGate({ root }).ok, true);
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const r = recordReview({ root, verdict: 'pass', reviewer: 'feature-dev:code-reviewer', reportPath: reportFile(GOOD_REPORT), summary: 's' });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.record.branch, 'feat');
  assert.equal(r.record.headSha, head);
  assert.equal(r.record.uncommitted, 0);
  assert.equal(r.record.docsOnly, false);
  assert.match(r.message, /分支 feat/);
  assert.ok(r.message.includes(head.slice(0, 12)), r.message);
  assert.equal(path.basename(path.dirname(r.record.report)), 'feat', '报告副本放在以分支命名的目录下');
  assert.equal(verify({ root }).ok, true, JSON.stringify(verify({ root })));

  // 同一工作树切到另一个分支再登记：最新记录换成新分支的，历史里两条都在、各带各的分支
  git(root, ['checkout', '-q', '-b', 'topic/second']);
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return [...new Set(items)].sort().reverse();\n}\n`);
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nassert.ok(dedup, 'reversed');\n");
  assert.equal(runGate({ root }).ok, true);
  const r2 = recordReview({ root, verdict: 'pass', reviewer: 'feature-dev:code-reviewer', reportPath: reportFile(GOOD_REPORT), summary: 's2' });
  assert.equal(r2.ok, true, r2.message);
  assert.equal(r2.record.branch, 'topic/second');
  assert.equal(r2.record.uncommitted, 2, '登记时还没提交的改动要如实记下');
  assert.match(r2.message, /未提交/);
  assert.match(path.basename(path.dirname(r2.record.report)), /^topic-second-[0-9a-f]{8}$/, '分支名里的斜杠不能成为目录层级');
  const log = fs.readFileSync(path.join(recordDir(root), 'reviews', 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((l) => l.branch), ['feat', 'topic/second']);
  assert.deepEqual(log.map((l) => l.headSha), [head, head]);
  assert.notEqual(log[0].treeHash, log[1].treeHash);
  assert.equal(readRecord(root, 'review.json').branch, 'topic/second');
});

test('复审登记（pre-push）：只改文档时树哈希不变，登记靠文档内容哈希和提交号区分每一轮', () => {
  const root = tmpRepo();
  write(root, 'engineering.config.json', JSON.stringify(TEST_CONFIG));
  write(root, 'pass.mjs', 'process.exit(0);\n');
  write(root, 'AGENTS.md', '# 规则\n');
  commitAll(root, 'base');
  git(root, ['checkout', '-q', '-b', 'rules']);
  const rounds = [];
  for (const text of ['# 规则\n\n第一轮\n', '# 规则\n\n第二轮\n']) {
    write(root, 'AGENTS.md', text);
    commitAll(root, `docs: ${text.length}`);
    assert.equal(runGate({ root }).ok, true);
    const r = recordReview({ root, verdict: 'pass', reviewer: 'general-purpose', reportPath: reportFile(GOOD_REPORT), summary: 's' });
    assert.equal(r.ok, true, r.message);
    rounds.push(r);
  }
  const [a, b] = rounds.map((r) => r.record);
  assert.equal(a.treeHash, b.treeHash, '闸门范围不含文档，两轮的树哈希相同（核对规则不变）');
  assert.equal(a.docsOnly, true);
  assert.equal(a.docFiles, 1);
  assert.notEqual(a.docHash, b.docHash, '文档内容哈希要能区分两轮');
  assert.notEqual(a.headSha, b.headSha);
  assert.match(rounds[1].message, /只有文档类改动/);
  assert.ok(rounds[1].message.includes(b.docHash.slice(0, 12)) && rounds[1].message.includes(b.headSha.slice(0, 12)), rounds[1].message);
  // 文档还没提交时再改一轮：提交号没变，文档内容哈希仍然不同
  write(root, 'AGENTS.md', '# 规则\n\n第三轮（未提交）\n');
  const r3 = recordReview({ root, verdict: 'pass', reviewer: 'general-purpose', reportPath: reportFile(GOOD_REPORT), summary: 's' });
  assert.equal(r3.ok, true, r3.message);
  assert.equal(r3.record.headSha, b.headSha);
  assert.notEqual(r3.record.docHash, b.docHash);
  assert.equal(r3.record.uncommitted, 1);
  assert.equal(verify({ root }).ok, true, '只改文档的推送仍然不要求记录');
});

test('复审登记（pre-push）：代码改动里夹着文档时也记文档内容哈希；游离 HEAD 时分支记为空', () => {
  const root = passingChange();
  write(root, 'docs/04-开发/note.md', '说明一\n');
  commitAll(root, 'feat');
  assert.equal(runGate({ root }).ok, true);
  const r1 = recordReview({ root, verdict: 'pass', reviewer: 'general-purpose', reportPath: reportFile(GOOD_REPORT), summary: 's' });
  write(root, 'docs/04-开发/note.md', '说明二\n');
  const r2 = recordReview({ root, verdict: 'pass', reviewer: 'general-purpose', reportPath: reportFile(GOOD_REPORT), summary: 's' });
  assert.equal(r1.record.docsOnly, false);
  assert.equal(r1.record.treeHash, r2.record.treeHash);
  assert.notEqual(r1.record.docHash, r2.record.docHash);
  git(root, ['checkout', '-q', '--detach']);
  // 0.5.1 起登记 fail 要求报告结论是不通过，所以这里用结论为不通过的报告
  const r3 = recordReview({ root, verdict: 'fail', reviewer: 'general-purpose', reportPath: reportFile(GOOD_REPORT.replace('通过\n', '不通过\n')), summary: 's' });
  assert.equal(r3.ok, true, r3.message);
  assert.equal(r3.record.branch, null);
  assert.match(r3.message, /游离/);
});

test('复审登记（pre-push）：分支目录名保留中文、不以点开头，换过字符的加短哈希避免两个分支落到同一目录', () => {
  assert.equal(branchDirName('feat'), 'feat');
  assert.equal(branchDirName('修复登录'), '修复登录');
  assert.equal(branchDirName(null), '_detached');
  assert.match(branchDirName('功能/导出'), /^功能-导出-[0-9a-f]{8}$/);
  assert.match(branchDirName('.hidden'), /^_hidden-[0-9a-f]{8}$/);
  assert.notEqual(branchDirName('x/a'), branchDirName('x-a'));
  assert.notEqual(branchDirName('x/a'), branchDirName('x a'));
  for (const name of ['x/a', '../up', 'a\\b', 'log.jsonl/x']) assert.ok(!/[\\/]/.test(branchDirName(name)), name);
});

test('复审登记（pre-push）：历史写不进去时登记整个不生效，不留下已生效的最新记录', () => {
  const root = passingChange();
  commitAll(root, 'feat');
  assert.equal(runGate({ root }).ok, true);
  // 把历史文件的位置占成目录，追加必然失败
  fs.mkdirSync(path.join(recordDir(root), 'reviews', 'log.jsonl'), { recursive: true });
  assert.throws(() => recordReview({ root, verdict: 'pass', reviewer: 'general-purpose', reportPath: reportFile(GOOD_REPORT), summary: 's' }));
  assert.equal(readRecord(root, 'review.json'), null);
  assert.equal(verify({ root }).ok, false, '登记没成功，推送核对不能通过');
});

test('复审登记（pre-push）：分支恰好叫 log.jsonl 时，报告目录不与历史文件冲突', () => {
  const root = passingChange();
  git(root, ['checkout', '-q', '-b', 'log.jsonl']);
  commitAll(root, 'feat');
  assert.equal(runGate({ root }).ok, true);
  const r = recordReview({ root, verdict: 'pass', reviewer: 'general-purpose', reportPath: reportFile(GOOD_REPORT), summary: 's' });
  assert.equal(r.ok, true, r.message);
  assert.ok(fs.statSync(path.join(recordDir(root), 'reviews', 'log.jsonl')).isFile());
});

test('闸门输出：删除的源文件计入测试先行的“无需测试”，注释检查不计；reviewIgnore 之内的源文件注释检查不计', () => {
  const root = featureRepo({ reviewIgnore: ['**/*.md', 'docs/**', 'src/legacy/**'] });
  fs.rmSync(path.join(root, 'src/dedup.ts'));
  fs.rmSync(path.join(root, 'test/dedup.test.ts'));
  write(root, 'src/legacy/old.ts', `${SRC_HEADER}export const old = 1;\n`);
  write(root, 'test/old.test.ts', "import { old } from '../src/legacy/old.ts';\nassert.ok(old);\n");
  const res = runGate({ root });
  assert.equal(res.ok, true, res.messages.join('\n'));
  // 改动的源文件 2 个：dedup.ts 已删除（无需测试），legacy/old.ts 被测试先行检查、但在 reviewIgnore 之内所以注释检查不看
  assert.deepEqual(res.record.staticChecks, { testFirst: { checked: 1, exempt: 0, skipped: 1 }, comments: { checked: 0, exempt: 0 } });
  assert.ok(res.messages.some((m) => /^测试先行检查通过.*无需测试 1 个，含已删除的/.test(m)), res.messages.join('\n'));
  assert.ok(res.messages.some((m) => /^注释检查通过.*不含 reviewIgnore 之内的和已删除的.*检查 0 个/.test(m)), res.messages.join('\n'));
});
