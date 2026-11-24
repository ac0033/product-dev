// 环节表测试（tools/stages.mjs 的 decideStage）：每个环节里的每项工作在哪做、为什么、谁定的。
// 业务含义：决定顺序固定为“用户的选择 > 两条原则自动判断 > 多种可行且原则指向不同时问用户”；
// 只能在某处做的（同一仓库副本、配了外部执行器的机器）不给选择；全量测试按 fullTests 落到本机/云端会话或 CI。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { BUNDLE_ROOT } from '../sync.mjs';
import { STAGE_IDS, decideStage } from '../tools/stages.mjs';
import { tmpRepo, write } from './helpers.mjs';

const item = (stage, env, id) => decideStage(stage, env).items.find((i) => i.id === id);

test('环节表：四个环节（推送前、PR 阶段、合并与收尾、每周巡检），每项都有去处、来源和理由', () => {
  assert.deepEqual(STAGE_IDS, ['A', 'B', 'C', 'W']);
  for (const stage of STAGE_IDS) {
    const d = decideStage(stage, { fullTests: 'local', reviewFlow: 'pre-push', hasServer: true });
    assert.ok(d.name && d.items.length > 0, stage);
    for (const i of d.items) {
      assert.ok(['user', 'config', 'fixed', 'principle', 'ask'].includes(i.source), `${stage}/${i.id} 来源 ${i.source}`);
      assert.ok(i.reason && i.label, `${stage}/${i.id} 要有标签和理由`);
      assert.equal(i.source === 'ask', i.where === null, `${stage}/${i.id}：只有问用户时没有去处`);
      if (i.source === 'ask') assert.ok(i.options.length >= 2, `${stage}/${i.id} 问用户要列出可选项`);
    }
  }
  assert.throws(() => decideStage('D', {}), /环节/, '发布和发布后验收不在套件的通用环节里');
});

test('环节表：只能在某处做的工作不给选择（同一仓库副本、外部执行器所在机器）', () => {
  assert.equal(item('A', { reviewFlow: 'pre-push' }, 'review-record').where, 'same-copy');
  assert.equal(item('A', { reviewFlow: 'pr', fullTests: 'ci', ciRunner: 'github-hosted' }, 'review-record'), undefined, 'pr 流程推送前没有复审记录');
  assert.equal(item('C', {}, 'merge-entry').where, 'same-copy');
  assert.equal(item('B', { externalExecutor: true }, 'independent-reviews').where, 'executor-machine');
  assert.equal(item('B', { externalExecutor: false }, 'independent-reviews').where, 'current-session');
  assert.match(item('B', { externalExecutor: true }, 'independent-reviews').reason, /先测试/, '外部复审可迁到服务器，但须先测试，不在这里实现');
});

test('环节表：全量测试按 fullTests 落地——ci 在 CI（托管或服务器），local 在会话所在环境', () => {
  const ciHosted = item('B', { fullTests: 'ci', reviewFlow: 'pr', ciRunner: 'github-hosted' }, 'ci-full-tests');
  assert.equal(ciHosted.where, 'github-hosted');
  assert.equal(ciHosted.source, 'config');
  const ciServer = item('B', { fullTests: 'ci', reviewFlow: 'pr', ciRunner: 'self-hosted', ciFallback: 'github-hosted' }, 'ci-full-tests');
  assert.equal(ciServer.where, 'server');
  assert.match(ciServer.reason, /github-hosted/, '写明后备');
  assert.equal(item('B', { fullTests: 'local' }, 'ci-full-tests'), undefined, 'local 时没有 CI 全量');
  assert.equal(item('A', { fullTests: 'ci', reviewFlow: 'pr', ciRunner: 'github-hosted' }, 'full-tests-local'), undefined, 'ci 时推送前不在本机跑全量');
  assert.ok(item('A', { fullTests: 'local' }, 'full-tests-local'));
});

test('决定顺序一：用户的选择最优先（会话偏好、对具体工作的指定）；指定了做不到的当作没答，转问用户', () => {
  const base = { fullTests: 'local', reviewFlow: 'pre-push', tight: true };
  // 项目选项 session 是用户在安装时的选择
  const byConfig = item('A', { ...base, session: 'local' }, 'full-tests-local');
  assert.deepEqual([byConfig.where, byConfig.source], ['local-session', 'user']);
  const cloud = item('A', { ...base, session: 'cloud' }, 'full-tests-local');
  assert.deepEqual([cloud.where, cloud.source], ['cloud-session', 'user']);
  // 对具体工作的指定盖过会话偏好
  const specific = item('A', { ...base, session: 'cloud', userChoices: { 'full-tests-local': 'local-session' } }, 'full-tests-local');
  assert.deepEqual([specific.where, specific.source], ['local-session', 'user']);
  // 没有服务器却指定服务器：做不到，转问用户，并说明
  const infeasible = item('W', { hasServer: false, userChoices: { 'weekly-inspection': 'server' } }, 'weekly-inspection');
  assert.equal(infeasible.source, 'ask');
  assert.match(infeasible.reason, /做不到/);
  assert.throws(() => decideStage('W', { userChoices: { 'weekly-inspection': 'mars' } }), /取值/);
});

test('决定顺序二：用户没选时按两条原则自动判断（更快、更便宜、更高效；本机资源紧张影响速度）', () => {
  // 资源充裕：本机又快又省、步骤最少 → 本机
  const roomy = item('A', { fullTests: 'local', reviewFlow: 'pre-push', tight: false }, 'full-tests-local');
  assert.deepEqual([roomy.where, roomy.source], ['local-session', 'principle']);
  // 资源紧张且有自己的服务器：服务器又快又不花钱，压过本机和云端
  const withServer = item('W', { tight: true, hasServer: true }, 'weekly-inspection');
  assert.deepEqual([withServer.where, withServer.source], ['server', 'principle']);
  // 资源充裕且有服务器：本机与服务器一样快一样省，取步骤最少的本机
  const roomyServer = item('W', { tight: false, hasServer: true }, 'weekly-inspection');
  assert.equal(roomyServer.where, 'local-session');
});

test('决定顺序三：多种可行且两条原则指向不同（云端更快但要花钱、本机更省但慢）时问用户，列出可选项和各自代价', () => {
  const ask = item('A', { fullTests: 'local', reviewFlow: 'pre-push', tight: true }, 'full-tests-local');
  assert.equal(ask.source, 'ask');
  assert.equal(ask.where, null);
  assert.deepEqual([...ask.options].sort(), ['cloud-session', 'local-session']);
  assert.match(ask.reason, /费用/, '写明云端的代价');
  const inspection = item('W', { tight: true, hasServer: false }, 'weekly-inspection');
  assert.equal(inspection.source, 'ask');
});

test('命令行：stages.mjs --stage 读项目配置，--choice 给 hasServer、externalExecutor 和对具体工作的指定，输出 JSON', () => {
  const root = tmpRepo();
  write(root, 'engineering.config.json', JSON.stringify({ profile: 2, modules: { gate: { reviewFlow: 'pr', fullTests: 'ci', ciRunner: 'github-hosted', requiredChecks: ['ci-gate'] }, environment: { session: 'local' } } }));
  const run = (...args) => spawnSync(process.execPath, [path.join(BUNDLE_ROOT, 'kit', 'tools', 'stages.mjs'), ...args], { encoding: 'utf8' });
  const out = run('--stage', 'B', '--target', root, '--choice', 'externalExecutor=true');
  assert.equal(out.status, 0, out.stderr);
  const parsed = JSON.parse(out.stdout);
  assert.equal(parsed.items.find((i) => i.id === 'ci-full-tests').where, 'github-hosted');
  assert.equal(parsed.items.find((i) => i.id === 'independent-reviews').where, 'executor-machine');
  const bad = run('--stage', 'Z', '--target', root);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /环节/);
});
