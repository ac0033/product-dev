// session / parallel 渲染进 AGENTS.md 规则块的测试。
// 业务含义：这两项只影响 agent 怎么做（默认在哪做、能不能并行），不换流程文件：值存在配置里，
// 同步时把一两句话渲染进套件规则块，让 agent 每次开工都读到；没声明（null）时写“按推荐原则由 agent 判断”；
// 配置改了、重新同步块就更新；块外的项目内容原样保留；CLAUDE.md 的块不受影响；检查工具能分清“配置变了块没跟上”和“块被手改”。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { BUNDLE_ROOT, syncKit } from '../sync.mjs';
import { checkBundle, findBlock, loadBundle, validateBundle } from '../tools/bundle-lib.mjs';
import { describeEnvironment, renderEnvironmentSection } from '../tools/environment.mjs';
import { commitAll, read, tmpDir, tmpRepo, write } from './helpers.mjs';

const USER_AGENTS = '# 项目指导\n\n这是项目自己的规则，不能被同步改动。\n';
const FACTS = { os: 'linux', cpus: 8, memGB: 16 };

/** 完整的项目配置（取套件模板，保证巡检能跑），只把 modules.environment 换成给定值。 */
function cfgJson(environment) {
  const tpl = JSON.parse(fs.readFileSync(path.join(BUNDLE_ROOT, 'kit', 'templates', 'engineering.config.json'), 'utf8'));
  tpl.modules = { ...(tpl.modules || {}), environment };
  return JSON.stringify(tpl, null, 2);
}

/** 已有配置的项目：environment 里写 session、parallel（不写的键就是未声明）。 */
function repoWith(environment) {
  const root = tmpRepo();
  write(root, 'AGENTS.md', USER_AGENTS);
  write(root, 'engineering.config.json', cfgJson(environment));
  commitAll(root, 'base');
  return root;
}

const blockOf = (root) => findBlock(read(root, 'AGENTS.md')).body;

test('渲染文本：四种取值各有明确说法，未声明时写按推荐原则由 agent 判断；不含标记行', () => {
  const text = (session, parallel) => renderEnvironmentSection({ session, parallel });
  assert.match(text('cloud', 'serial'), /会话（`session`）：.*云端会话.*费用.*按 R2.*授权表.*未列的先问用户/s);
  assert.doesNotMatch(text('cloud', 'serial'), /开工前先问用户/, '项目授权表已列明启动云端会话时按表执行，不能一律写成要先问');
  assert.match(text('cloud', 'serial'), /并行（`parallel`）：串行/);
  assert.match(text('local', 'parallel'), /会话（`session`）：优先本地会话/);
  assert.match(text('local', 'parallel'), /并行（`parallel`）：能并行的并行/);
  const none = text(null, null);
  assert.match(none, /会话（`session`）：未声明，agent 按/);
  assert.match(none, /并行（`parallel`）：未声明/);
  assert.notEqual(text('cloud', 'serial'), text('local', 'serial'));
  assert.notEqual(text('cloud', 'serial'), text('cloud', 'parallel'));
  for (const t of [text('cloud', 'serial'), none]) {
    assert.ok(!t.includes('engineering-kit:'), '正文不能带标记行');
    assert.match(t, /默认偏好/);
    assert.match(t, /不改变流程步骤与标准/);
    assert.match(t, /用户当次的选择优先/);
  }
  assert.throws(() => renderEnvironmentSection({ session: 'moon', parallel: null }), /session/);
  assert.throws(() => renderEnvironmentSection({ session: null, parallel: 'many' }), /parallel/);
});

test('渲染与装完时的说明同源：同一取值的一句话在两处一致，不各写一份', () => {
  for (const [session, parallel] of [['cloud', 'serial'], ['local', 'parallel'], [null, null]]) {
    const section = renderEnvironmentSection({ session, parallel });
    const described = describeEnvironment({ fullTests: 'local', session, parallel }, FACTS).filter((l) => l.startsWith('会话：') || l.startsWith('并行：'));
    assert.equal(described.length, 2);
    for (const line of described) assert.ok(section.includes(line.replace(/^(会话|并行)：/, '')), `渲染文本里要有说明里的这句：${line}`);
  }
});

test('同步：配置里的 session、parallel 渲染进 AGENTS.md 的规则块，块外内容不动', () => {
  const root = repoWith({ session: 'cloud', parallel: 'serial' });
  const r = syncKit({ target: root });
  assert.equal(r.ok, true, r.messages.join('\n'));
  const agents = read(root, 'AGENTS.md');
  assert.ok(agents.startsWith(USER_AGENTS), '块外的项目内容必须原样保留');
  const body = blockOf(root);
  assert.ok(body.endsWith(renderEnvironmentSection({ session: 'cloud', parallel: 'serial' }).trim()), '渲染的内容放在块的末尾');
  assert.ok(body.includes('### 流程地图'), '套件规则本身仍在');
});

test('同步：没声明时渲染“未声明，由 agent 判断”，不凭空写值', () => {
  const root = repoWith({});
  syncKit({ target: root });
  assert.match(blockOf(root), /会话（`session`）：未声明/);
  assert.match(blockOf(root), /并行（`parallel`）：未声明/);
});

test('首次安装按选择写配置，规则块同时渲染所选值', () => {
  const root = tmpRepo();
  write(root, 'AGENTS.md', USER_AGENTS);
  commitAll(root, 'base');
  const env = { values: { fullTests: 'local', reviewFlow: 'pre-push', session: 'cloud', parallel: 'serial' }, facts: FACTS };
  const r = syncKit({ target: root, env });
  assert.equal(r.ok, true, r.messages.join('\n'));
  assert.match(blockOf(root), /会话（`session`）：.*云端会话/s);
  assert.match(blockOf(root), /并行（`parallel`）：串行/);
});

test('配置改了重新同步：块里的偏好跟着更新，块外内容仍不变，重复同步结果不变', () => {
  const root = repoWith({ session: 'cloud', parallel: 'serial' });
  syncKit({ target: root });
  const before = read(root, 'AGENTS.md');
  assert.equal(syncKit({ target: root }).ok, true);
  assert.equal(read(root, 'AGENTS.md'), before, '重复同步幂等');
  write(root, 'engineering.config.json', cfgJson({ session: 'local', parallel: 'parallel' }));
  syncKit({ target: root });
  const after = read(root, 'AGENTS.md');
  assert.ok(after.startsWith(USER_AGENTS));
  assert.match(blockOf(root), /会话（`session`）：优先本地会话/);
  assert.doesNotMatch(blockOf(root), /并行（`parallel`）：串行/);
  assert.notEqual(after, before);
});

test('CLAUDE.md 的块不渲染环境偏好', () => {
  const root = repoWith({ session: 'cloud', parallel: 'serial' });
  write(root, 'CLAUDE.md', '# 项目\n');
  commitAll(root, 'claude');
  syncKit({ target: root });
  assert.doesNotMatch(read(root, 'CLAUDE.md'), /session|并行/);
});

test('漂移检查：同步后一致；配置改了块没跟上报“过期”并提示重新同步；块被手改仍报“被改动”', () => {
  const root = repoWith({ session: 'cloud', parallel: 'serial' });
  syncKit({ target: root });
  assert.equal(checkBundle({ root, bundleRoot: BUNDLE_ROOT }).ok, true);
  const agentsState = () => checkBundle({ root, bundleRoot: BUNDLE_ROOT }).items.find((i) => i.file === 'AGENTS.md');
  write(root, 'engineering.config.json', cfgJson({ session: 'local', parallel: 'serial' }));
  const stale = agentsState();
  assert.equal(stale.state, 'outdated', JSON.stringify(stale));
  assert.match(stale.detail, /重新同步/);
  syncKit({ target: root });
  assert.equal(agentsState().state, 'ok');
  write(root, 'AGENTS.md', read(root, 'AGENTS.md').replace('1. 开工：', '1. 开工（被改动）：'));
  assert.equal(agentsState().state, 'modified');
  syncKit({ target: root });
  write(root, 'AGENTS.md', read(root, 'AGENTS.md').replace('优先本地会话', '随便哪里'));
  assert.equal(agentsState().state, 'modified', '手改渲染段不能当成“只是配置变了”');
});

test('漂移检查：同一版本号下还是不带渲染段的旧静态块，报“过期”（缺渲染段，重新同步即可），不当成被手改', () => {
  const root = repoWith({ session: 'cloud', parallel: 'serial' });
  syncKit({ target: root });
  const head = fs.readFileSync(path.join(BUNDLE_ROOT, 'kit', 'rules', 'AGENTS.block.md'), 'utf8');
  const version = loadBundle(BUNDLE_ROOT).bundleVersion;
  const text = read(root, 'AGENTS.md');
  const found = findBlock(text);
  write(root, 'AGENTS.md', `${text.slice(0, found.start)}<!-- engineering-kit:begin v${version} -->\n${head.trim()}\n<!-- engineering-kit:end -->${text.slice(found.end)}`);
  const item = checkBundle({ root, bundleRoot: BUNDLE_ROOT }).items.find((i) => i.file === 'AGENTS.md');
  assert.equal(item.state, 'outdated', JSON.stringify(item));
  assert.match(item.detail, /重新同步/);
  syncKit({ target: root });
  assert.equal(checkBundle({ root, bundleRoot: BUNDLE_ROOT }).items.find((i) => i.file === 'AGENTS.md').state, 'ok');
});

test('清单：render 只认 environment，写错在写入前报错；当前清单只给 AGENTS 块渲染', () => {
  const bundle = loadBundle(BUNDLE_ROOT);
  const rendered = bundle.components.filter((c) => c.render).map((c) => c.id);
  assert.deepEqual(rendered, ['rules-agents']);
  const dir = tmpDir('ekit-render-');
  fs.mkdirSync(path.join(dir, 'kit'));
  fs.writeFileSync(path.join(dir, 'kit', 'r.md'), '规则\n');
  const base = { name: 'x', bundleVersion: '1.0.0', configFormat: 'profile' };
  const comp = (extra) => ({ id: 'r', kind: 'rules', owner: 'block', source: 'kit/r.md', target: 'AGENTS.md', ...extra });
  assert.doesNotThrow(() => validateBundle({ ...base, components: [comp({ render: 'environment' })] }, dir));
  assert.throws(() => validateBundle({ ...base, components: [comp({ render: 'weather' })] }, dir), /render/);
  assert.throws(() => validateBundle({ ...base, components: [{ id: 'g', kind: 'gate', owner: 'kit', source: 'kit/r.md', target: 'g.mjs', render: 'environment' }] }, dir), /render/);
});

test('旧清单（没有 render 字段）同步出的块不带环境偏好，回滚到旧版不会混入新段', () => {
  const root = repoWith({ session: 'cloud', parallel: 'serial' });
  const old = tmpDir('ekit-old-');
  fs.cpSync(BUNDLE_ROOT, old, { recursive: true, filter: (src) => !src.includes(`${path.sep}tests`) });
  const bj = path.join(old, 'bundle.json');
  const j = JSON.parse(fs.readFileSync(bj, 'utf8'));
  for (const c of j.components) delete c.render;
  fs.writeFileSync(bj, JSON.stringify(j, null, 2));
  syncKit({ target: root, bundleRoot: old });
  assert.doesNotMatch(blockOf(root), /执行偏好/);
  assert.equal(checkBundle({ root, bundleRoot: old }).items.find((i) => i.file === 'AGENTS.md').state, 'ok');
});
