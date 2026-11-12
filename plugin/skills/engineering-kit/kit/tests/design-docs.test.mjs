// 设计文档落位测试：新项目第一步装好套件后，产品设计阶段的文档按约定位置和状态写入，巡检与推送核对都不报错。
// 业务含义：设计技能与工程套件共用一套目录和状态用词；这里防止两边再次各说各话（旧位置 docs/design/、中文状态值）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runHygiene } from '../gate/hygiene.mjs';
import { newFileProblems } from '../gate/verify.mjs';
import { DEFAULTS, normalizeConfig } from '../gate/config.mjs';
import { isIgnoredDoc } from '../gate/lib.mjs';
import { syncKit } from '../sync.mjs';
import { commitAll, git, read, tmpRepo, write } from './helpers.mjs';

/** 设计阶段的全部产物：路径 → 文件头状态。位置与产品设计技能的共享协议一致。 */
const DESIGN_DOCS = {
  'docs/00-总览/PROJECT_STATE.md': 'active',
  'docs/00-总览/RECORDS.md': 'active',
  'docs/00-总览/IMPLEMENTATION.md': 'draft',
  'docs/01-需求/PRD.md': 'review',
  'docs/02-原型/PROTOTYPE.md': 'draft',
  'docs/03-架构/ARCHITECTURE.md': 'active',
  'docs/adr/ADR-0001-存储选型.md': 'accepted',
};

/** 装好套件并提交基线的新项目，当前在功能分支上。 */
function installedProject() {
  const root = tmpRepo();
  write(root, 'README.md', '# 项目\n');
  commitAll(root, 'init');
  const res = syncKit({ target: root, hooks: false });
  assert.equal(res.ok, true, JSON.stringify(res));
  commitAll(root, 'install kit');
  git(root, ['checkout', '-q', '-b', 'design']);
  return root;
}

test('设计文档：按约定位置和状态写入后，巡检零错误、推送核对不拦位置', () => {
  const root = installedProject();
  for (const [rel, status] of Object.entries(DESIGN_DOCS)) write(root, rel, `# ${rel}\n\n状态：${status}\n\n正文 ${rel}\n`);
  write(root, 'docs/02-原型/prototype/index.html', '<!doctype html><title>原型</title>\n');
  const config = normalizeConfig(JSON.parse(read(root, 'engineering.config.json')));
  assert.deepEqual(newFileProblems(root, config, { newFiles: {} }), []);
  // 还没登记到各阶段 README 时，巡检按 R6 逐个报出（记录目录 docs/adr/ 不登记，不报）
  const before = runHygiene(root).findings.error;
  assert.equal(before.length, 7, JSON.stringify(before));
  assert.ok(before.every((e) => /未登记到该阶段的 README/.test(e)) && !before.some((e) => /docs\/adr\//.test(e)), JSON.stringify(before));
  // 按套件装好的阶段 README 模板（表格）登记：文件登记文件名，原型目录登记目录名
  const rows = { '00-总览': ['PROJECT_STATE.md', 'RECORDS.md', 'IMPLEMENTATION.md'], '01-需求': ['PRD.md'], '02-原型': ['PROTOTYPE.md', 'prototype/'], '03-架构': ['ARCHITECTURE.md'] };
  for (const [stage, names] of Object.entries(rows)) {
    write(root, `docs/${stage}/README.md`, `${read(root, `docs/${stage}/README.md`).trimEnd()}\n${names.map((n) => `| ${n} | 设计 | active | 说明 |`).join('\n')}\n`);
  }
  const report = runHygiene(root);
  assert.deepEqual(report.findings.error, [], JSON.stringify(report.findings.error));
});

test('升级：旧配置缺少新状态值和总览目录时，同步给出升级提示且不改项目配置', () => {
  const root = installedProject();
  const cfg = JSON.parse(read(root, 'engineering.config.json'));
  cfg.layout.stages = ['01-原型', '02-需求分析', '03-架构设计', '04-开发', '05-测试', '06-预发部署'];
  cfg.hygiene.statusValues = ['draft', 'active', 'accepted', 'superseded', 'done', 'archived'];
  const before = `${JSON.stringify(cfg, null, 2)}
`;
  write(root, 'engineering.config.json', before);
  const res = syncKit({ target: root, hooks: false });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(res.messages.some((m) => /升级提示/.test(m) && /statusValues/.test(m) && /review/.test(m)), JSON.stringify(res.messages));
  assert.ok(res.messages.some((m) => /升级提示/.test(m) && /layout.stages/.test(m) && /00-总览/.test(m)), JSON.stringify(res.messages));
  assert.equal(read(root, 'engineering.config.json'), before);
});

test('升级：旧配置的复审者名单缺少新默认名字时给出升级提示，不改项目配置', () => {
  const root = installedProject();
  const cfg = JSON.parse(read(root, 'engineering.config.json'));
  cfg.modules.review.reviewers = ['feature-dev:code-reviewer', '/code-review', 'general-purpose'];
  const before = `${JSON.stringify(cfg, null, 2)}\n`;
  write(root, 'engineering.config.json', before);
  const res = syncKit({ target: root, hooks: false });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(res.messages.some((m) => /升级提示/.test(m) && /modules\.review\.reviewers/.test(m) && /product-dev:code-reviewer/.test(m)), JSON.stringify(res.messages));
  assert.equal(read(root, 'engineering.config.json'), before);
  // 项目有意精简名单（留着新名字，删了别的）：不提示
  cfg.modules.review.reviewers = ['product-dev:code-reviewer', 'general-purpose'];
  write(root, 'engineering.config.json', JSON.stringify(cfg, null, 2));
  const slim = syncKit({ target: root, hooks: false });
  assert.ok(!slim.messages.some((m) => /modules\.review\.reviewers/.test(m)), JSON.stringify(slim.messages));
});

test('默认免审范围只含纯说明文件：规则、技能正文、提示词、可执行原型都要审', () => {
  const root = installedProject();
  const { reviewIgnore } = normalizeConfig(JSON.parse(read(root, 'engineering.config.json')));
  assert.deepEqual(reviewIgnore, DEFAULTS.reviewIgnore, '模板与缺省值一致');
  for (const f of ['docs/01-需求/PRD.md', 'docs/_templates/plan.md', 'README.md', 'CHANGELOG.md']) assert.ok(isIgnoredDoc(f, reviewIgnore), f);
  for (const f of ['AGENTS.md', 'CLAUDE.md', 'skills/x/SKILL.md', 'prompts/system.md', 'agents/reviewer.md', 'docs/02-原型/prototype/index.html', 'docs/02-原型/prototype/app.js', 'PRODUCT.md', 'DESIGN.md']) {
    assert.ok(!isIgnoredDoc(f, reviewIgnore), f);
  }
});

test('impeccable 的落位：.impeccable/ 在默认白名单里，根目录的 PRODUCT.md、DESIGN.md 巡检与推送核对都不拦', () => {
  const root = installedProject();
  write(root, '.impeccable/config.json', '{}\n');
  write(root, 'PRODUCT.md', '# 产品摘要\n\n产品权威是 docs/01-需求/PRD.md。\n');
  write(root, 'DESIGN.md', '# 设计系统\n');
  commitAll(root, 'impeccable');
  const config = normalizeConfig(JSON.parse(read(root, 'engineering.config.json')));
  assert.deepEqual(newFileProblems(root, config, { newFiles: {} }), []);
  const errors = runHygiene(root).findings.error;
  assert.ok(!errors.some((e) => /顶层目录不在白名单/.test(e)), JSON.stringify(errors));
});

test('升级：旧的宽免审范围、pr 流程未列必需检查、根目录有 .impeccable/ 而白名单缺它时给出升级提示，不改项目配置', () => {
  const root = installedProject();
  const cfg = JSON.parse(read(root, 'engineering.config.json'));
  cfg.rules.reviewIgnore = ['**/*.md', 'docs/**'];
  cfg.modules.gate.reviewFlow = 'pr';
  delete cfg.modules.gate.requiredChecks;
  cfg.layout.topLevelAllowed = cfg.layout.topLevelAllowed.filter((d) => d !== '.impeccable');
  const before = `${JSON.stringify(cfg, null, 2)}\n`;
  write(root, 'engineering.config.json', before);
  write(root, '.impeccable/config.json', '{}\n');
  const res = syncKit({ target: root, hooks: false });
  assert.equal(res.ok, true, JSON.stringify(res));
  const has = (re) => res.messages.some((m) => /升级提示/.test(m) && re.test(m));
  assert.ok(res.messages.some((m) => /升级提示/.test(m) && m.includes('rules.reviewIgnore（**/*.md、docs/**）把 AGENTS.md、CLAUDE.md、skills/x/SKILL.md、prompts/x.md、docs/02-原型/x.html')), JSON.stringify(res.messages));
  assert.ok(has(/modules\.gate\.requiredChecks/), JSON.stringify(res.messages));
  assert.ok(res.messages.some((m) => /升级提示/.test(m) && m.includes('layout.topLevelAllowed') && m.includes('.impeccable/')), JSON.stringify(res.messages));
  assert.equal(read(root, 'engineering.config.json'), before);
  // 收窄免审范围、列出必需检查名、白名单加上 .impeccable 后不再提示
  cfg.rules.reviewIgnore = ['docs/**/*.md'];
  cfg.modules.gate.requiredChecks = ['test'];
  cfg.layout.topLevelAllowed.push('.impeccable');
  write(root, 'engineering.config.json', JSON.stringify(cfg, null, 2));
  const fixed = syncKit({ target: root, hooks: false });
  assert.ok(!fixed.messages.some((m) => /升级提示/.test(m)), JSON.stringify(fixed.messages));
  // 有意保持空列表（每一项都必需）的 pr 项目：写了这个键就不再提示
  cfg.modules.gate.requiredChecks = [];
  write(root, 'engineering.config.json', JSON.stringify(cfg, null, 2));
  const empty = syncKit({ target: root, hooks: false });
  assert.ok(!empty.messages.some((m) => /requiredChecks/.test(m)), JSON.stringify(empty.messages));
  // 宽免审范围按匹配结果判断：等价的另一种写法同样提示，只免审 docs 下 Markdown 的不提示
  for (const [ignore, warned] of [[['*.md'], true], [['docs/**/*'], true], [['docs/**/*.md', 'README.md'], false]]) {
    cfg.rules.reviewIgnore = ignore;
    write(root, 'engineering.config.json', JSON.stringify(cfg, null, 2));
    const r = syncKit({ target: root, hooks: false });
    assert.equal(r.messages.some((m) => /升级提示/.test(m) && /rules\.reviewIgnore/.test(m)), warned, `${JSON.stringify(ignore)}：${JSON.stringify(r.messages)}`);
  }
});

test('升级：旧版扁平配置按顶层键判断——没写 requiredChecks、reviewIgnore 时提示，写了（含空数组）就不提示', () => {
  const root = installedProject();
  const template = JSON.parse(read(root, 'engineering.config.json'));
  const flat = { base: 'main', reviewFlow: 'pr', sourceGlobs: ['src/**/*.ts'], testGlobs: ['test/**/*.ts'] };
  const hints = (cfg) => {
    write(root, 'engineering.config.json', JSON.stringify(cfg, null, 2));
    return syncKit({ target: root, hooks: false, dryRun: true }).messages.filter((m) => /升级提示/.test(m));
  };
  const bare = hints(flat);
  assert.ok(bare.some((m) => /modules\.gate\.requiredChecks/.test(m)), JSON.stringify(bare));
  assert.ok(bare.some((m) => /没有写 rules\.reviewIgnore/.test(m)), JSON.stringify(bare));
  const set = hints({ ...flat, requiredChecks: [], reviewIgnore: ['docs/**/*.md'] });
  assert.deepEqual(set, [], '扁平配置写了这两个键就不提示');
  // profile 配置看 rules.reviewIgnore：模板写了就不提示“没有写”，删掉才提示
  assert.ok(!hints(template).some((m) => /没有写 rules\.reviewIgnore/.test(m)));
  const { reviewIgnore, ...rules } = template.rules;
  assert.ok(reviewIgnore);
  assert.ok(hints({ ...template, rules }).some((m) => /没有写 rules\.reviewIgnore/.test(m)));
});

test('升级：配置已是当前默认时不给升级提示', () => {
  const root = installedProject();
  const res = syncKit({ target: root, hooks: false });
  assert.ok(!res.messages.some((m) => /升级提示/.test(m)), JSON.stringify(res.messages));
});

test('设计文档：旧位置 docs/design/ 被推送核对拦截，中文状态值被巡检报错', () => {
  const root = installedProject();
  write(root, 'docs/design/PRD.md', '状态：draft\n');
  write(root, 'docs/01-需求/PRD.md', '状态：基线\n');
  const config = normalizeConfig(JSON.parse(read(root, 'engineering.config.json')));
  const problems = newFileProblems(root, config, { newFiles: {} });
  assert.ok(problems.some((p) => /docs\/design\/PRD\.md/.test(p)), JSON.stringify(problems));
  const report = runHygiene(root);
  assert.ok(report.findings.error.some((e) => /状态不合法（基线）/.test(e)), JSON.stringify(report.findings.error));
});
