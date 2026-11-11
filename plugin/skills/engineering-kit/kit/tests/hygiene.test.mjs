// 巡检测试：目录白名单、禁用文件名、死链、状态合法性、记录类只追加、重复内容、空目录、已合并分支与残留工作树。
// 巡检只报告不删除；每个用例在临时仓库里跑真实的 git 状态。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bannedTokensIn, relativeLinks, runHygiene, statusOf, topLevelDirs } from '../gate/hygiene.mjs';
import { commitAll, git, tmpRepo, write } from './helpers.mjs';

/** 写入项目配置（profile 结构），并提交一次基线。 */
function repoWith(files) {
  const root = tmpRepo();
  write(root, 'engineering.config.json', JSON.stringify({
    profile: 2,
    modules: { gate: { base: 'main' } },
    layout: { sourceGlobs: ['src/**/*.ts'], testGlobs: ['tests/**/*.ts'], topLevelAllowed: ['docs', 'src', 'tests'], stages: ['01-原型', '04-开发'] },
    hygiene: { bannedNameTokens: ['copy', 'final', 'bak'], staleDraftDays: 30, recordDirs: ['docs/acceptance'], statusValues: ['draft', 'active', 'accepted', 'superseded', 'done', 'archived'] },
    rules: { reviewIgnore: ['**/*.md'], commentMode: 'header' },
  }, null, 2));
  for (const [f, t] of Object.entries(files)) write(root, f, t);
  commitAll(root, 'base');
  return root;
}

test('辅助函数：文件名片段按分隔符切分；链接、状态、顶层目录', () => {
  assert.deepEqual(bannedTokensIn('docs/spec-final.md', ['final', 'copy']), ['final']);
  assert.deepEqual(bannedTokensIn('docs/finalize.md', ['final']), [], '片段必须完整匹配，不做子串匹配');
  assert.deepEqual(relativeLinks('见 [a](./a.md#x) 与 [外链](https://x.y) 与 [b](b/c.md)'), ['./a.md', 'b/c.md']);
  assert.equal(statusOf('# 标题\n\n状态：Accepted\n'), 'accepted');
  assert.equal(statusOf('# 标题\n无状态\n'), null);
  assert.deepEqual(topLevelDirs(['a.md', 'docs/x.md', 'src/y.ts', 'docs/z.md']), ['docs', 'src']);
});

test('顶层目录白名单：不在白名单的目录报错', () => {
  const root = repoWith({ 'docs/a.md': 'x\n', 'junk/b.txt': 'y\n' });
  const rep = runHygiene(root);
  assert.ok(rep.findings.error.some((e) => /junk\//.test(e)), JSON.stringify(rep.findings));
  assert.equal(rep.ok, false);
});

test('禁用文件名：copy、final 等片段只提示，不删除', () => {
  const root = repoWith({ 'docs/spec-final.md': '内容\n', 'docs/finalize.md': '另一个\n' });
  const rep = runHygiene(root);
  assert.ok(rep.findings.warn.some((w) => /spec-final\.md/.test(w)));
  assert.ok(!rep.findings.warn.some((w) => /finalize\.md/.test(w)));
  assert.ok(fs.existsSync(path.join(root, 'docs', 'spec-final.md')), '巡检不删除文件');
});

test('死链：文档里指向不存在的文件报错', () => {
  const root = repoWith({ 'docs/README.md': '状态：active\n\n[缺失](missing.md)\n' });
  const rep = runHygiene(root);
  assert.ok(rep.findings.error.some((e) => /死链.*missing\.md/.test(e)), JSON.stringify(rep.findings));
});

test('状态：不合法的状态值报错；合法值通过', () => {
  const root = repoWith({ 'docs/a.md': '状态：unknown\n', 'docs/b.md': '状态：active\n' });
  const rep = runHygiene(root);
  assert.ok(rep.findings.error.some((e) => /状态不合法.*a\.md/.test(e)));
  assert.ok(!rep.findings.error.some((e) => /b\.md/.test(e)));
});

test('记录类文档只追加：已提交的记录文件被修改时报错，新增文件不报', () => {
  const root = repoWith({ 'docs/acceptance/2026-11-01.md': '原始记录\n' });
  write(root, 'docs/acceptance/2026-11-01.md', '被改写的记录\n');
  write(root, 'docs/acceptance/2026-11-02.md', '新的记录\n');
  const rep = runHygiene(root);
  assert.ok(rep.findings.error.some((e) => /不得修改旧文件.*2026-11-01/.test(e)), JSON.stringify(rep.findings.error));
  assert.ok(!rep.findings.error.some((e) => /2026-11-02/.test(e)));
});

test('重复内容与空目录：提示', () => {
  const root = repoWith({ 'docs/a.md': '同样的内容\n', 'docs/b.md': '同样的内容\n' });
  fs.mkdirSync(path.join(root, 'docs', 'empty'));
  const rep = runHygiene(root);
  assert.ok(rep.findings.warn.some((w) => /内容重复.*a\.md.*b\.md/.test(w)));
  assert.ok(rep.findings.warn.some((w) => /空目录.*docs\/empty/.test(w)));
});

test('索引：阶段目录未登记到 docs/README.md 时提示；缺少索引也提示', () => {
  const root = repoWith({ 'docs/04-开发/a.md': '状态：active\n', 'docs/README.md': '状态：active\n索引里没有阶段\n' });
  const rep = runHygiene(root);
  assert.ok(rep.findings.warn.some((w) => /未登记到索引.*04-开发/.test(w)));
  const root2 = repoWith({ 'src/x.ts': '\n' });
  assert.ok(runHygiene(root2).findings.warn.some((w) => /缺少文档索引/.test(w)));
});

test('已合并分支与残留工作树：提示（不删除）', () => {
  const root = repoWith({ 'docs/a.md': '状态：active\n' });
  git(root, ['checkout', '-q', '-b', 'old-feature']);
  git(root, ['checkout', '-q', 'main']);
  const wtDir = fs.mkdtempSync(path.join(path.dirname(root), 'ekit-wt-'));
  fs.rmSync(wtDir, { recursive: true, force: true });
  git(root, ['worktree', 'add', '-q', wtDir, 'old-feature']);
  // 基准分支 main 在本仓库里存在（TEST_CONFIG 的 base），old-feature 与 main 内容一致，视为已合并
  const rep = runHygiene(root);
  assert.ok(rep.findings.warn.some((w) => /分支内容已在.*old-feature/.test(w)), JSON.stringify(rep.findings.warn));
  assert.ok(rep.findings.warn.some((w) => /残留工作树/.test(w)));
  git(root, ['worktree', 'remove', '--force', wtDir]);
});

test('巡检不崩溃：已在工作区删除未暂存的文件、含 % 的链接', () => {
  const root = repoWith({ 'docs/a.md': '状态：active\n\n[x](50%.md)\n', 'docs/gone.md': '状态：active\n' });
  fs.rmSync(path.join(root, 'docs', 'gone.md'));
  const rep = runHygiene(root);
  assert.ok(rep.findings.error.some((e) => /死链.*50%\.md/.test(e)), JSON.stringify(rep.findings));
  assert.deepEqual(relativeLinks('[a](50%.md)'), ['50%.md']);
});

test('记录类文档只追加：修改已提交（相对基准分支）后也能查到', () => {
  const root = repoWith({ 'docs/acceptance/2026-11-01.md': '原始记录\n' });
  git(root, ['checkout', '-q', '-b', 'feat']);
  write(root, 'docs/acceptance/2026-11-01.md', '被改写的记录\n');
  commitAll(root, 'rewrite record');
  const rep = runHygiene(root);
  assert.ok(rep.findings.error.some((e) => /不得修改旧文件.*2026-11-01/.test(e)), JSON.stringify(rep.findings));
});

test('草稿超期：按最近提交时间算，不按文件时间（重新克隆后文件时间是新的）', () => {
  const root = tmpRepo();
  write(root, 'engineering.config.json', JSON.stringify({ profile: 2, modules: { gate: { base: 'main' } }, layout: { sourceGlobs: ['src/**/*.ts'], testGlobs: ['tests/**/*.ts'], topLevelAllowed: ['docs'] } }));
  write(root, 'docs/d.md', '状态：draft\n');
  process.env.GIT_COMMITTER_DATE = '2020-01-01T00:00:00Z';
  try {
    commitAll(root, 'old draft');
  } finally {
    delete process.env.GIT_COMMITTER_DATE;
  }
  const rep = runHygiene(root);
  assert.ok(rep.findings.warn.some((w) => /草稿超过.*d\.md/.test(w)), JSON.stringify(rep.findings));
});

/** 只取“阶段内登记”一项检查报出的错误。 */
const unregistered = (root) => runHygiene(root).findings.error.filter((e) => /该阶段的 README/.test(e));

test('阶段内登记（R6）：阶段目录里的文件没登记到该阶段的 README 时报错，登记后不报', () => {
  const root = repoWith({
    'docs/README.md': '状态：active\n\n01-原型 04-开发\n',
    'docs/04-开发/README.md': '状态：active\n\n| 文件 | 说明 |\n|---|---|\n| plan.md | 计划 |\n| [契约](contract.md) | 链接写法 |\n| `notes.md` | 反引号写法 |\n',
    'docs/04-开发/plan.md': '状态：active\n计划\n',
    'docs/04-开发/contract.md': '状态：active\n契约\n',
    'docs/04-开发/notes.md': '状态：active\n笔记\n',
    'docs/04-开发/PRD.md': '状态：active\n没登记\n',
  });
  const hits = unregistered(root);
  assert.equal(hits.length, 1, JSON.stringify(hits));
  assert.match(hits[0], /docs\/04-开发\/PRD\.md/);
  assert.equal(runHygiene(root).ok, false);
  fs.appendFileSync(path.join(root, 'docs/04-开发/README.md'), '| PRD.md | 补登记 |\n');
  assert.deepEqual(unregistered(root), []);
});

test('阶段内登记（R6）：文件名只是别的登记名的一部分不算登记；子目录登记目录名即可', () => {
  const root = repoWith({
    'docs/README.md': '状态：active\n\n01-原型 04-开发\n',
    'docs/01-原型/README.md': '状态：active\n\n| 文件 | 说明 |\n|---|---|\n| my-spec.md | 规格 |\n| prototype/ | 原型文件 |\n',
    'docs/01-原型/my-spec.md': '状态：active\n规格\n',
    'docs/01-原型/spec.md': '状态：active\n名字是 my-spec.md 的一部分\n',
    'docs/01-原型/prototype/index.html': '<!doctype html>\n',
    'docs/01-原型/prototype/js/app.js': '// x\n',
    'docs/01-原型/assets/logo.svg': '<svg/>\n',
  });
  const hits = unregistered(root);
  assert.deepEqual(hits.map((e) => e.match(/docs\/[^\s（]+/)[0]).sort(), ['docs/01-原型/assets/logo.svg', 'docs/01-原型/spec.md'], JSON.stringify(hits));
});

test('阶段内登记（R6）：子目录里的同名文件不靠裸文件名算登记；说明列里的词不算登记', () => {
  const root = repoWith({
    'docs/README.md': '状态：active\n\n01-原型 04-开发\n',
    'docs/04-开发/README.md': '状态：active\n\n| 文件 | 说明 |\n|---|---|\n| plan.md | 图片放在 assets 目录 |\n| sub/ok.md | 按相对路径登记 |\n',
    'docs/04-开发/plan.md': '状态：active\n计划\n',
    'docs/04-开发/sub/plan.md': '状态：active\n另一份同名文件\n',
    'docs/04-开发/sub/ok.md': '状态：active\n已登记\n',
    'docs/04-开发/assets/a.png': 'png\n',
  });
  const hits = unregistered(root);
  assert.deepEqual(hits.map((e) => e.match(/docs\/[^\s（]+/)[0]).sort(), ['docs/04-开发/assets/a.png', 'docs/04-开发/sub/plan.md'], JSON.stringify(hits));
});

test('阶段内登记（R6）：带标题和尖括号的链接算登记；点开头的文件不查；README 文件名不分大小写；记录目录写了结尾斜杠也排除', () => {
  const root = tmpRepo();
  write(root, 'engineering.config.json', JSON.stringify({
    profile: 2,
    modules: { gate: { base: 'main' } },
    layout: { sourceGlobs: ['src/**/*.ts'], testGlobs: ['tests/**/*.ts'], topLevelAllowed: ['docs'], stages: ['04-开发'] },
    hygiene: { recordDirs: ['docs/04-开发/records/'] },
  }));
  write(root, 'docs/README.md', '状态：active\n\n04-开发\n');
  write(root, 'docs/04-开发/readme.md', '状态：active\n\n- [计划](plan.md "开发计划")\n- [说明](<my notes.md>)\n');
  write(root, 'docs/04-开发/plan.md', '状态：active\n计划\n');
  write(root, 'docs/04-开发/my notes.md', '状态：active\n说明\n');
  write(root, 'docs/04-开发/.gitkeep', '');
  write(root, 'docs/04-开发/records/2026-11-01.md', '记录\n');
  commitAll(root, 'base');
  assert.deepEqual(unregistered(root), []);
  write(root, 'docs/04-开发/extra.md', '状态：active\n没登记\n');
  assert.equal(unregistered(root).length, 1);
});

test('阶段内登记（R6）：阶段目录有文件却没有 README 时报错；记录目录和模板目录不查', () => {
  const root = repoWith({
    'docs/README.md': '状态：active\n\n01-原型 04-开发\n',
    'docs/04-开发/plan.md': '状态：active\n计划\n',
    'docs/acceptance/2026-11-01.md': '验收记录\n',
    'docs/_templates/plan.md': '模板\n',
  });
  const hits = unregistered(root);
  assert.equal(hits.length, 1, JSON.stringify(hits));
  assert.match(hits[0], /docs\/04-开发\/.*没有该阶段的 README/);
});

test('阶段内登记（R6）：记录目录设在阶段目录之内时，其中的文件也不查', () => {
  const root = tmpRepo();
  write(root, 'engineering.config.json', JSON.stringify({
    profile: 2,
    modules: { gate: { base: 'main' } },
    layout: { sourceGlobs: ['src/**/*.ts'], testGlobs: ['tests/**/*.ts'], topLevelAllowed: ['docs'], stages: ['06-发布'] },
    hygiene: { recordDirs: ['docs/06-发布/records'] },
  }));
  write(root, 'docs/README.md', '状态：active\n\n06-发布\n');
  write(root, 'docs/06-发布/README.md', '状态：active\n\n| 文件 | 说明 |\n|---|---|\n');
  write(root, 'docs/06-发布/records/2026-11-01.md', '发布记录\n');
  commitAll(root, 'base');
  assert.deepEqual(runHygiene(root).findings.error, []);
});
