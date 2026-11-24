// 环节表测试（tools/stages.mjs 的 decideStage）：每个环节里的每项工作在哪做、为什么、谁定的。
// 业务含义：决定顺序固定为“用户的选择 > 两条原则自动判断 > 多种可行且原则指向不同时问用户”；
// 只能在某处做的（同一工作树/仓库副本、配了外部执行器的机器）不给选择；全量测试按 fullTests 落到本机/云端会话或 CI；
// pre-push 与 pr 两种复审流程的环节不同；输入（函数参数、命令行）严格校验，不静默丢弃或改意思。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { BUNDLE_ROOT } from '../sync.mjs';
import { STAGE_IDS, buildEnv, byPrinciples, decideStage, parseStageArgs } from '../tools/stages.mjs';
import { tmpRepo, write } from './helpers.mjs';

const item = (stage, env, id) => decideStage(stage, env).items.find((i) => i.id === id);
const ids = (stage, env) => decideStage(stage, env).items.map((i) => i.id);
const PR = { reviewFlow: 'pr', fullTests: 'ci', ciRunner: 'github-hosted' };

test('环节表：四个环节，每项都有去处、来源和理由；发布（D）不在通用环节里', () => {
  assert.deepEqual(STAGE_IDS, ['A', 'B', 'C', 'W']);
  for (const env of [{ fullTests: 'local', reviewFlow: 'pre-push', hasServer: true }, { ...PR, externalExecutor: true }]) {
    for (const stage of STAGE_IDS) {
      const d = decideStage(stage, env);
      assert.ok(d.name && d.items.length > 0, stage);
      for (const i of d.items) {
        assert.ok(['user', 'config', 'fixed', 'principle', 'ask'].includes(i.source), `${stage}/${i.id} 来源 ${i.source}`);
        assert.ok(i.reason && i.label, `${stage}/${i.id} 要有标签和理由`);
        assert.equal(i.source === 'ask', i.where === null, `${stage}/${i.id}：只有问用户时没有去处`);
        if (i.source === 'ask') assert.ok(i.options.length >= 2, `${stage}/${i.id} 问用户要列出可选项`);
      }
    }
  }
  assert.throws(() => decideStage('D', {}), /环节/);
});

test('环节表：两种复审流程的工作各在各的环节——pre-push 的复审与登记在推送前，pr 的在 PR 阶段；合并方式也不同', () => {
  assert.deepEqual(ids('A', { reviewFlow: 'pre-push' }), ['static', 'affected', 'full-tests-local', 'independent-reviews', 'review-record']);
  assert.deepEqual(ids('B', { reviewFlow: 'pre-push' }), ['fix-findings'], 'pre-push 的复审已在推送前做完，PR 阶段只剩处理意见');
  assert.deepEqual(ids('A', PR), ['static', 'affected'], 'pr 流程推送前不复审、全量交 CI');
  assert.deepEqual(ids('B', PR), ['ci-full-tests', 'independent-reviews', 'review-register', 'fix-findings']);
  assert.equal(item('C', PR, 'merge-entry').where, 'same-copy');
  assert.equal(item('C', { reviewFlow: 'pre-push' }, 'merge-entry'), undefined, 'pre-push 流程没有合并入口脚本');
  assert.equal(item('C', { reviewFlow: 'pre-push' }, 'merge').where, 'current-session');
  assert.equal(item('C', PR, 'merge'), undefined);
});

test('环节表：只能在某处做的工作不给选择——同一工作树（pre-push 登记）、同一仓库副本（pr 登记与合并）、外部执行器所在机器', () => {
  assert.equal(item('A', { reviewFlow: 'pre-push' }, 'review-record').where, 'same-worktree');
  assert.match(item('A', { reviewFlow: 'pre-push' }, 'review-record').reason, /工作树/);
  assert.equal(item('B', PR, 'review-register').where, 'same-copy');
  for (const [stage, env, id] of [['A', { reviewFlow: 'pre-push', externalExecutor: true }, 'independent-reviews'], ['B', { ...PR, externalExecutor: true }, 'independent-reviews']]) {
    assert.equal(item(stage, env, id).where, 'executor-machine', `${stage}：执行器在哪，复审就只能在哪`);
    assert.match(item(stage, env, id).reason, /先测试/, '外部复审可迁到服务器，但须先测试，不在这里实现');
  }
  assert.equal(item('B', PR, 'independent-reviews').where, 'current-session');
});

test('环节表：全量测试按 fullTests 落地——ci 在 CI（托管或服务器，写明后备和 CI_RUNNER、系统矩阵的限制），local 在会话所在环境', () => {
  const hosted = item('B', PR, 'ci-full-tests');
  assert.deepEqual([hosted.where, hosted.source], ['github-hosted', 'config']);
  assert.match(hosted.reason, /CI_RUNNER/);
  assert.match(hosted.reason, /Windows、macOS/);
  const self = item('B', { ...PR, ciRunner: 'self-hosted', ciFallback: 'github-hosted', hasServer: true }, 'ci-full-tests');
  assert.equal(self.where, 'server');
  assert.match(self.reason, /后备 github-hosted/);
  assert.equal(item('B', { fullTests: 'local' }, 'ci-full-tests'), undefined);
  assert.equal(item('A', PR, 'full-tests-local'), undefined);
  // 配了自托管却明确没有服务器：不替用户决定，转问
  const noServer = item('B', { ...PR, ciRunner: 'self-hosted', hasServer: false }, 'ci-full-tests');
  assert.deepEqual([noServer.where, noServer.source], [null, 'ask']);
  assert.ok(noServer.options.includes('github-hosted'));
  assert.equal(item('B', { ...PR, ciRunner: 'self-hosted' }, 'ci-full-tests').where, 'server', '不知道有没有服务器时按项目选项');
});

test('决定顺序一：用户的选择最优先；指定了做不到的转问用户，理由写对', () => {
  const base = { fullTests: 'local', reviewFlow: 'pre-push', tight: true };
  const byConfig = item('A', { ...base, session: 'local' }, 'full-tests-local');
  assert.deepEqual([byConfig.where, byConfig.source], ['local-session', 'user']);
  const cloud = item('A', { ...base, session: 'cloud' }, 'full-tests-local');
  assert.deepEqual([cloud.where, cloud.source], ['cloud-session', 'user']);
  const specific = item('A', { ...base, session: 'cloud', userChoices: { 'full-tests-local': 'local-session' } }, 'full-tests-local');
  assert.deepEqual([specific.where, specific.source], ['local-session', 'user']);
  const noServer = item('W', { hasServer: false, userChoices: { 'weekly-inspection': 'server' } }, 'weekly-inspection');
  assert.equal(noServer.source, 'ask');
  assert.match(noServer.reason, /没有确认有可用的服务器/);
  // 有服务器，但这项工作（全量测试）不能放服务器：理由不能说成“没有服务器”
  const notHere = item('A', { ...base, hasServer: true, userChoices: { 'full-tests-local': 'server' } }, 'full-tests-local');
  assert.equal(notHere.source, 'ask');
  assert.match(notHere.reason, /不能放在那里/);
  assert.ok(!/没有确认有可用的服务器/.test(notHere.reason));
});

test('决定顺序二：用户没选时按两条原则自动判断；并列时取步骤最少的，与列出先后无关', () => {
  const roomy = item('A', { fullTests: 'local', reviewFlow: 'pre-push', tight: false }, 'full-tests-local');
  assert.deepEqual([roomy.where, roomy.source], ['local-session', 'principle']);
  const withServer = item('W', { tight: true, hasServer: true }, 'weekly-inspection');
  assert.deepEqual([withServer.where, withServer.source], ['server', 'principle']);
  assert.equal(item('W', { tight: false, hasServer: true }, 'weekly-inspection').where, 'local-session');
  // 直接测并列规则：列出顺序反过来也选本机（本机与服务器一样快一样省，本机步骤更少）
  assert.equal(byPrinciples(['server', 'local-session'], false), 'local-session');
  assert.equal(byPrinciples(['local-session', 'server'], false), 'local-session');
  assert.equal(byPrinciples(['cloud-session', 'server', 'local-session'], true), 'server');
  assert.equal(byPrinciples(['local-session', 'cloud-session'], true), null, '本机慢但省、云端快但花钱：没有赢家');
});

test('决定顺序三：多种可行且两条原则指向不同时问用户，列出可选项和各自代价', () => {
  const ask = item('A', { fullTests: 'local', reviewFlow: 'pre-push', tight: true }, 'full-tests-local');
  assert.equal(ask.source, 'ask');
  assert.equal(ask.where, null);
  assert.deepEqual([...ask.options].sort(), ['cloud-session', 'local-session']);
  assert.match(ask.reason, /费用/);
  assert.equal(item('W', { tight: true, hasServer: false }, 'weekly-inspection').source, 'ask');
  // 不知道有没有服务器（没确认）不当作有：服务器不在可选范围里
  const unknown = item('W', { tight: true }, 'weekly-inspection');
  assert.equal(unknown.source, 'ask');
  assert.ok(!unknown.options.includes('server'));
});

test('输入校验：取值不对就报错，不静默当成别的意思；undefined 当作没给', () => {
  for (const bad of [{ fullTests: 'unknown' }, { reviewFlow: 'x' }, { ciRunner: 'mars' }, { session: 'moon' }, { hasServer: 'false' }, { externalExecutor: 'false' }, { tight: 1 },
    { fullTests: 'ci', reviewFlow: 'pr', ciRunner: 'none' }, { fullTests: 'ci', reviewFlow: 'pr' }]) {
    assert.throws(() => decideStage('A', bad), /取值不对|必须是|须声明/, JSON.stringify(bad));
  }
  // undefined 不覆盖默认值（命令行没有配置文件时传来的就是 undefined）
  assert.deepEqual(ids('A', { fullTests: undefined, reviewFlow: undefined, ciRunner: undefined }), ['static', 'affected', 'full-tests-local', 'independent-reviews', 'review-record']);
  // 对具体工作的指定：必须是该环节里可选的工作、取值必须是三个去处之一
  assert.throws(() => decideStage('W', { userChoices: { 'weekly-inspection': 'mars' } }), /取值/);
  assert.throws(() => decideStage('W', { userChoices: { typo: 'server' } }), /没有可选去处的工作/);
  assert.throws(() => decideStage('W', { userChoices: { 'full-tests-local': 'local-session' } }), /没有可选去处的工作/, '别的环节的工作不能在这里指定');
  assert.throws(() => decideStage('C', { userChoices: { cleanup: 'cloud-session' } }), /固定|没有可选去处的工作/, '固定去处的工作不能指定');
});

test('命令行参数：严格解析，未知参数、缺值、重复、写法不对都报错', () => {
  const ok = parseStageArgs(['--stage', 'A', '--target', 'x', '--choice', 'hasServer=true', '--choice', 'tight=false', '--choice', 'full-tests-local=cloud-session']);
  assert.deepEqual(ok, { stage: 'A', target: 'x', env: { hasServer: true, tight: false }, userChoices: { 'full-tests-local': 'cloud-session' } });
  for (const [args, re] of [
    [['--stage'], /缺少值/], [['--stage', 'A', '--choice'], /缺少值/], [['--choice', '--stage', 'A'], /缺少值/],
    [['--stage', 'A', '--stage', 'B'], /只能写一次/], [['--stage', 'A', '--target', 'a', '--target', 'b'], /只能写一次/],
    [['--stage', 'A', '--choice', 'hasServer'], /键=值/], [['--stage', 'A', '--choice', 'hasServer=TRUE'], /true 或 false/],
    [['--stage', 'A', '--choice', 'tight=1'], /true 或 false/],
    [['--stage', 'A', '--choice', 'hasServer=true', '--choice', 'hasServer=false'], /重复/],
    [['--stage', 'A', '--choice', 'x=local-session', '--choice', 'x=server'], /重复/],
    [['--stage', 'A', '--oops', '1'], /不认识的参数/], [['A'], /不认识的参数/], [[], /缺少 --stage/],
  ]) assert.throws(() => parseStageArgs(args), re, JSON.stringify(args));
});

test('buildEnv：命令行的 tight 盖过本机探测，没给就按本机 CPU 与内存（4 核或 8 GB 以内算紧张）；配置字段与参数原样带上', () => {
  const config = { fullTests: 'ci', ciRunner: 'self-hosted', ciFallback: 'github-hosted', reviewFlow: 'pr', session: 'local' };
  const args = (env = {}, userChoices = {}) => ({ stage: 'W', env, userChoices });
  assert.equal(buildEnv(config, args(), { cpus: 2, memGB: 32 }).tight, true, 'CPU 少');
  assert.equal(buildEnv(config, args(), { cpus: 16, memGB: 8 }).tight, true, '内存少');
  assert.equal(buildEnv(config, args(), { cpus: 16, memGB: 64 }).tight, false);
  assert.equal(buildEnv(config, args({ tight: false }), { cpus: 2, memGB: 4 }).tight, false, '命令行盖过探测');
  assert.equal(buildEnv(config, args({ tight: true }), { cpus: 16, memGB: 64 }).tight, true);
  const e = buildEnv(config, args({ hasServer: true, externalExecutor: true }, { 'weekly-inspection': 'cloud-session' }), { cpus: 16, memGB: 64 });
  assert.deepEqual([e.fullTests, e.ciRunner, e.ciFallback, e.reviewFlow, e.session, e.hasServer, e.externalExecutor], ['ci', 'self-hosted', 'github-hosted', 'pr', 'local', true, true]);
  assert.deepEqual(e.userChoices, { 'weekly-inspection': 'cloud-session' });
});

const run = (...args) => spawnSync(process.execPath, [path.join(BUNDLE_ROOT, 'kit', 'tools', 'stages.mjs'), ...args], { encoding: 'utf8' });
const cfg = (gate, environment) => JSON.stringify({ profile: 2, modules: { gate, ...(environment ? { environment } : {}) } });

test('命令行：项目配置的各字段正确映射（reviewFlow、fullTests、ciRunner、ciFallback、session），输出配置来源', () => {
  const root = tmpRepo();
  write(root, 'engineering.config.json', cfg({ reviewFlow: 'pr', fullTests: 'ci', ciRunner: 'self-hosted', ciFallback: 'github-hosted', requiredChecks: ['ci-gate'] }, { session: 'cloud' }));
  const b = run('--stage', 'B', '--target', root, '--choice', 'externalExecutor=true', '--choice', 'hasServer=true', '--choice', 'tight=false');
  assert.equal(b.status, 0, b.stderr);
  const parsed = JSON.parse(b.stdout);
  assert.match(parsed.configSource, /effective|working-tree/);
  const ci = parsed.items.find((i) => i.id === 'ci-full-tests');
  assert.equal(ci.where, 'server', 'ciRunner 映射');
  assert.match(ci.reason, /后备 github-hosted/, 'ciFallback 映射');
  assert.equal(parsed.items.find((i) => i.id === 'independent-reviews').where, 'executor-machine', 'externalExecutor 解析');
  assert.ok(parsed.items.some((i) => i.id === 'review-register'), 'reviewFlow=pr 映射');
  // session=cloud 映射成用户的选择；hasServer、tight 解析
  const w = JSON.parse(run('--stage', 'W', '--target', root, '--choice', 'tight=false', '--choice', 'hasServer=true').stdout);
  assert.deepEqual([w.items[0].where, w.items[0].source], ['cloud-session', 'user']);
  // 没有配置文件：按默认值（pre-push、全量在本机），资源紧张由 --choice tight 指定
  const empty = tmpRepo();
  const a = JSON.parse(run('--stage', 'A', '--target', empty, '--choice', 'tight=true').stdout);
  assert.deepEqual(a.items.map((i) => i.id), ['static', 'affected', 'full-tests-local', 'independent-reviews', 'review-record'], '默认值没被 undefined 覆盖');
  assert.equal(a.items.find((i) => i.id === 'full-tests-local').source, 'ask', 'tight=true 生效');
  const tightOff = JSON.parse(run('--stage', 'A', '--target', empty, '--choice', 'tight=false').stdout);
  assert.equal(tightOff.items.find((i) => i.id === 'full-tests-local').where, 'local-session');
  assert.match(a.configSource, /none/);
});

test('命令行：写错的输入退出码非零并给出原因', () => {
  const root = tmpRepo();
  write(root, 'engineering.config.json', cfg({}));
  for (const [args, re] of [
    [['--stage', 'Z', '--target', root], /环节/],
    [['--stage', 'W', '--target', root, '--choice', 'hasServer'], /键=值/],
    [['--stage', 'W', '--target', root, '--choice', 'hasServer=TRUE'], /true 或 false/],
    [['--stage', 'W', '--target', root, '--choice', 'weekly-inspectoin=server'], /没有可选去处的工作/],
    [['--stage', 'W', '--target', root, '--bogus', 'x'], /不认识的参数/],
  ]) {
    const r = run(...args);
    assert.notEqual(r.status, 0, args.join(' '));
    assert.match(r.stderr, re, args.join(' '));
  }
});
