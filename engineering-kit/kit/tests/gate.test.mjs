// 闸门行为测试：测试先行、注释、测试记录、复审记录、树哈希绑定与推送前核对。
// 每个用例都在临时 git 仓库里跑真实流程，不 mock git。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { checkComments } from '../gate/check-comments.mjs';
import { checkTestFirst, referencesModule } from '../gate/check-test-first.mjs';
import { changedFiles, scopeFiles, treeHash } from '../gate/lib.mjs';
import { runGate } from '../gate/gate.mjs';
import { recordReview } from '../gate/review.mjs';
import { verify } from '../gate/verify.mjs';
import { commitAll, featureRepo, git, read, reportFile, SRC_HEADER, TEST_CONFIG, tmpRepo, write } from './helpers.mjs';

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
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nconsole.log(dedup, 'sorted');\n");
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
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nconsole.log(dedup, 'sorted');\n");
  const result = runGate({ root });
  assert.equal(result.ok, true, result.messages.join('\n'));
  assert.equal(result.record.passed, true);
  assert.equal(result.record.treeHash, treeHash(root, scopeFiles(root, cfg)));
});

test('测试记录：测试失败 → 记录 passed=false，闸门不通过', () => {
  const root = featureRepo({ testCommand: 'node fail.mjs' });
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return [...new Set(items)].sort();\n}\n`);
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nconsole.log(dedup, 'sorted');\n");
  const result = runGate({ root });
  assert.equal(result.ok, false);
  assert.equal(result.record.passed, false);
});

test('复审记录：报告太短 → 拒绝', () => {
  const root = featureRepo();
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return [...new Set(items)].sort();\n}\n`);
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nconsole.log(dedup, 'sorted');\n");
  assert.equal(runGate({ root }).ok, true);
  const rp = reportFile('结论\n通过\n');
  const r = recordReview({ root, verdict: 'pass', reviewer: 'feature-dev:code-reviewer', reportPath: rp, summary: 's' });
  assert.equal(r.ok, false);
  assert.match(r.message, /不少于/);
});

test('复审记录：复审者不在允许名单 → 拒绝', () => {
  const root = featureRepo();
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return [...new Set(items)].sort();\n}\n`);
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nconsole.log(dedup, 'sorted');\n");
  runGate({ root });
  const rp = reportFile(GOOD_REPORT);
  const r = recordReview({ root, verdict: 'pass', reviewer: 'me-myself', reportPath: rp, summary: 's' });
  assert.equal(r.ok, false);
  assert.match(r.message, /复审者/);
});

test('复审记录：报告结论写“不通过”却记 pass → 拒绝', () => {
  const root = featureRepo();
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return [...new Set(items)].sort();\n}\n`);
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nconsole.log(dedup, 'sorted');\n");
  runGate({ root });
  const rp = reportFile(GOOD_REPORT.replace('通过\n', '不通过\n'));
  const r = recordReview({ root, verdict: 'pass', reviewer: 'feature-dev:code-reviewer', reportPath: rp, summary: 's' });
  assert.equal(r.ok, false);
  assert.match(r.message, /不通过/);
});

test('复审记录：没有通过的测试记录时拒绝（先跑闸门）', () => {
  const root = featureRepo();
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return [...new Set(items)].sort();\n}\n`);
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nconsole.log(dedup, 'sorted');\n");
  const rp = reportFile(GOOD_REPORT);
  const r = recordReview({ root, verdict: 'pass', reviewer: 'feature-dev:code-reviewer', reportPath: rp, summary: 's' });
  assert.equal(r.ok, false);
  assert.match(r.message, /先运行闸门/);
});

test('推送前核对：完整流程通过；改源文件后作废；只改文档仍有效', () => {
  const root = featureRepo();
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return [...new Set(items)].sort();\n}\n`);
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nconsole.log(dedup, 'sorted');\n");
  assert.equal(runGate({ root }).ok, true);
  const rp = reportFile(GOOD_REPORT);
  assert.equal(recordReview({ root, verdict: 'pass', reviewer: 'feature-dev:code-reviewer', reportPath: rp, summary: 's' }).ok, true);
  commitAll(root, 'feat: dedup sorted');
  assert.equal(verify({ root }).ok, true, JSON.stringify(verify({ root })));

  write(root, 'docs/note.md', '只改文档\n');
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
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nconsole.log(dedup, 'sorted');\n");
  return root;
}

test('测试命令环境变量：配置的 testEnv 会传给测试命令（Python 等项目靠它设置 PYTHONPATH）', () => {
  const withEnv = runGate({ root: envRepo({ testCommand: 'node check-env.mjs', testEnv: { KIT_TEST_FLAG: 'on' } }) });
  assert.equal(withEnv.ok, true, withEnv.messages.join('\n'));
  const withoutEnv = runGate({ root: envRepo({ testCommand: 'node check-env.mjs' }) });
  assert.equal(withoutEnv.ok, false);
});

test('测试先行：Python 的 “from 包 import 模块” 写法也算引用', () => {
  assert.equal(referencesModule('from pdf_translation import budget\n', 'budget'), true);
  assert.equal(referencesModule('from pdf_translation import tools, budget\n', 'budget'), true);
  assert.equal(referencesModule('from pdf_translation.budget import Budget\n', 'budget'), true);
  assert.equal(referencesModule('from pdf_translation import budget_helpers\n', 'budget'), false);
  assert.equal(referencesModule("import { x } from '../src/dedup.ts';\n", 'dedup'), true);
});
