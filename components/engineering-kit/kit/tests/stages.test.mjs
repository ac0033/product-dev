// 环节表测试（tools/stages.mjs 的 decideStage）：每个环节里的每项工作在哪做、为什么、谁定的。
// 业务含义：决定顺序固定为“用户的选择 > 两条原则自动判断 > 多种可行且原则指向不同时问用户”；
// 只能在某处做的（同一工作树/仓库副本、配了外部执行器的机器）不给选择；全量测试按 fullTests 落到本机/云端会话或 CI；
// pre-push 与 pr 两种复审流程的环节不同；输入（函数参数、命令行）严格校验，不静默丢弃或改意思。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { BUNDLE_ROOT } from '../sync.mjs';
import { detectFacts, isConstrained } from '../tools/environment.mjs';
import { STAGE_IDS, buildEnv, byPrinciples, decideStage, parseStageArgs, planFromArgs, docRows } from '../tools/stages.mjs';
import { commitAll, git, tmpDir, tmpRepo, write } from './helpers.mjs';

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

test('来源如实标注：对具体工作的指定是 user，项目选项（可能是装套件时按推荐写入的）是 config，不冒充用户指定', () => {
  const env = { fullTests: 'local', reviewFlow: 'pre-push', session: 'cloud' };
  assert.equal(item('A', env, 'full-tests-local').source, 'config');
  assert.match(item('A', env, 'full-tests-local').reason, /项目选项 session=cloud/);
  assert.equal(item('A', { ...env, userChoices: { 'full-tests-local': 'cloud-session' } }, 'full-tests-local').source, 'user');
});

test('关键理由文字被锁住：pre-push 合并要等 CI 全部通过、记录只证明推送前；全量测试的 CI_RUNNER 说明', () => {
  const merge = item('C', { reviewFlow: 'pre-push' }, 'merge');
  assert.match(merge.reason, /CI 全部通过/, '不是只等必需检查');
  assert.match(merge.reason, /推送前/);
  assert.match(merge.reason, /用户授权/);
  assert.match(item('C', PR, 'merge-entry').reason, /用户授权/);
  assert.match(item('B', PR, 'review-register').reason, /不跨副本/);
});

test('pre-push 合并的 CI 条件只在有 CI 时适用：ciRunner 为 none（没有 CI）时不再说要等 CI 全部通过', () => {
  const withCi = item('C', { reviewFlow: 'pre-push', ciRunner: 'github-hosted' }, 'merge');
  assert.match(withCi.reason, /CI 全部通过/);
  const undeclared = item('C', { reviewFlow: 'pre-push' }, 'merge');
  assert.match(undeclared.reason, /CI 全部通过/, '没声明 CI 时按可能有 CI 处理');
  const none = item('C', { reviewFlow: 'pre-push', ciRunner: 'none' }, 'merge');
  assert.ok(!/CI 全部通过/.test(none.reason), none.reason);
  assert.match(none.reason, /没有 CI/);
  assert.match(none.reason, /用户授权/);
  assert.match(none.reason, /推送前/, '记录只证明推送前的状态这一条对无 CI 的项目同样成立');
});

test('决定顺序一：用户的选择最优先；指定了做不到的转问用户，理由写对', () => {
  const base = { fullTests: 'local', reviewFlow: 'pre-push', tight: true };
  const byConfig = item('A', { ...base, session: 'local' }, 'full-tests-local');
  assert.deepEqual([byConfig.where, byConfig.source], ['local-session', 'config']);
  const cloud = item('A', { ...base, session: 'cloud' }, 'full-tests-local');
  assert.deepEqual([cloud.where, cloud.source], ['cloud-session', 'config']);
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
  // 没传 hasServer 时，全量测试这类原本就不能放服务器的工作，理由也不能说成“没确认服务器”
  const notHereUnknown = item('A', { ...base, userChoices: { 'full-tests-local': 'server' } }, 'full-tests-local');
  assert.match(notHereUnknown.reason, /不能放在那里/);
  assert.ok(!/没有确认有可用的服务器/.test(notHereUnknown.reason));
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
    { fullTests: 'ci', reviewFlow: 'pr', ciRunner: 'none' }, { fullTests: 'ci', reviewFlow: 'pr' },
    // 与项目配置同一口径：配置拒绝的组合这里也拒绝（ci 搭 pre-push、后备取 none、后备与主用相同）
    { fullTests: 'ci', reviewFlow: 'pre-push', ciRunner: 'github-hosted' }, { ...PR, ciFallback: 'none' }, { ...PR, ciFallback: 'github-hosted' }]) {
    assert.throws(() => decideStage('A', bad), /环境取值不成立|必须是/, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => decideStage('A', { ...PR, ciRunner: 'self-hosted', ciFallback: 'github-hosted' }));
  // null 不是“没给”：fullTests、reviewFlow 必须有值，传 null 明确拒绝，不静默漏排工作
  for (const k of ['fullTests', 'reviewFlow']) assert.throws(() => decideStage('A', { [k]: null }), /不能是 null/, k);
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
    [['--stage', 'A', '--target', ''], /缺少值/], [['--stage', ''], /缺少值/], [['--stage', 'A', '--choice', ''], /缺少值/],
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
  assert.deepEqual([w.items[0].where, w.items[0].source], ['cloud-session', 'config']);
  // 没有配置文件：按默认值（pre-push、全量在本机），资源紧张由 --choice tight 指定
  const empty = tmpRepo();
  const a = JSON.parse(run('--stage', 'A', '--target', empty, '--choice', 'tight=true').stdout);
  assert.deepEqual(a.items.map((i) => i.id), ['static', 'affected', 'full-tests-local', 'independent-reviews', 'review-record'], '默认值没被 undefined 覆盖');
  assert.equal(a.items.find((i) => i.id === 'full-tests-local').source, 'ask', 'tight=true 生效');
  const tightOff = JSON.parse(run('--stage', 'A', '--target', empty, '--choice', 'tight=false').stdout);
  assert.equal(tightOff.items.find((i) => i.id === 'full-tests-local').where, 'local-session');
  assert.match(a.configSource, /none/);
});

test('planFromArgs：没给 tight 时用探测到的本机事实（可注入），给了就不探测；配置来源如实标注', () => {
  const root = tmpRepo();
  write(root, 'engineering.config.json', cfg({}));
  const w = (facts) => planFromArgs(['--stage', 'W', '--target', root], { detect: () => facts }).items[0];
  assert.equal(w({ cpus: 2, memGB: 32 }).source, 'ask', 'CPU 少：本机慢、云端花钱，没有赢家');
  assert.equal(w({ cpus: 16, memGB: 64 }).where, 'local-session');
  const given = planFromArgs(['--stage', 'W', '--target', root, '--choice', 'tight=false'], { detect: () => { throw new Error('给了 tight 就不该探测'); } });
  assert.equal(given.items[0].where, 'local-session');
  assert.match(given.configSource, /effective|working-tree/);
  // 基准分支解析不了：取工作区文件并如实标注，不假称是生效的策略
  const bad = tmpRepo();
  write(bad, 'engineering.config.json', JSON.stringify({ profile: 2, modules: { gate: { base: 'no-such-branch' } } }));
  commitAll(bad, 'base');
  const planned = planFromArgs(['--stage', 'A', '--target', bad, '--choice', 'tight=false']);
  assert.match(planned.configSource, /^working-tree.*无法取得基准提交上的判定策略/, planned.configSource);
  assert.match(planned.configSource, /no-such-branch/, '把 loadConfig 带回的具体原因写进来');
});

test('配置来源：基准上还没有配置时如实说是工作区值；基准上的配置是坏 JSON 时报真实错误，不压成“读不到基准”', () => {
  // 首次安装：基准提交里没有 engineering.config.json，工作区才有
  const first = tmpRepo();
  write(first, 'README.md', '# x\n');
  commitAll(first, 'base');
  git(first, ['checkout', '-q', '-b', 'feat']);
  write(first, 'engineering.config.json', cfg({}));
  const planned = planFromArgs(['--stage', 'A', '--target', first, '--choice', 'tight=false']);
  assert.match(planned.configSource, /^working-tree/, '基准上没有配置：策略取自工作区，不能标成“生效的基准策略”');
  assert.match(planned.configSource, /基准提交上还没有配置/);
  // 基准上有配置：标明取自基准提交（带提交号前缀），与上面可区分
  const based = tmpRepo();
  write(based, 'engineering.config.json', cfg({}));
  commitAll(based, 'base');
  git(based, ['checkout', '-q', '-b', 'feat']);
  const fromBase = planFromArgs(['--stage', 'A', '--target', based, '--choice', 'tight=false']);
  assert.match(fromBase.configSource, /^effective（策略字段取基准提交 [0-9a-f]{12} 上的/);
  assert.notEqual(fromBase.configSource, planned.configSource);
  // 基准上的配置不是合法 JSON：真实错误原样报出
  const broken = tmpRepo();
  write(broken, 'engineering.config.json', '{ not json');
  commitAll(broken, 'base');
  git(broken, ['checkout', '-q', '-b', 'feat']);
  write(broken, 'engineering.config.json', cfg({}));
  assert.throws(() => planFromArgs(['--stage', 'A', '--target', broken, '--choice', 'tight=false']), /JSON|合法/);
  // 不是 git 仓库的目录：取工作区文件并标注
  const plain = tmpDir('stages-plain-');
  write(plain, 'engineering.config.json', cfg({}));
  assert.match(planFromArgs(['--stage', 'A', '--target', plain, '--choice', 'tight=false']).configSource, /^working-tree（不是 git 仓库/);
  // Git 自己出错（不是“不是仓库”）：保留诊断，不当成普通目录
  const saved = { c: process.env.GIT_CONFIG_COUNT, k: process.env.GIT_CONFIG_KEY_0, v: process.env.GIT_CONFIG_VALUE_0 };
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = 'nodotkey';
  process.env.GIT_CONFIG_VALUE_0 = 'x';
  try {
    // 仓库里 Git 因配置解析出错（退出码 128）：不能说成“不是仓库”，要保留诊断
    assert.throws(() => planFromArgs(['--stage', 'A', '--target', based, '--choice', 'tight=false']), /git 出错/);
  } finally {
    for (const [k, v] of [['GIT_CONFIG_COUNT', saved.c], ['GIT_CONFIG_KEY_0', saved.k], ['GIT_CONFIG_VALUE_0', saved.v]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('命令行真实运行：没给 tight 时按本机探测，结果与同一台机器的判定一致', () => {
  const root = tmpRepo();
  write(root, 'engineering.config.json', cfg({}));
  const out = run('--stage', 'A', '--target', root);
  assert.equal(out.status, 0, out.stderr);
  const full = JSON.parse(out.stdout).items.find((i) => i.id === 'full-tests-local');
  // 本机紧张时（4 核或 8 GB 以内）本机慢、云端花钱，要问；否则本机
  assert.equal(full.source, isConstrained(detectFacts(root)) ? 'ask' : 'principle');
});

test('文档与代码对齐：process.md 的环节表里，每个环节的每项工作都有一行，工作名、去处关键词、谁定三栏与代码一致', () => {
  const doc = fs.readFileSync(path.join(BUNDLE_ROOT, 'references', 'process.md'), 'utf8');
  const rows = docRows();
  assert.ok(rows.length >= 11, '环节表的行数');
  // 共用一行的工作必须显式列出：新增工作沿用已有行的文字，也要在这里改（有意识地改，而不是悄悄通过）
  const SHARED = { 'A|静态检查、受影响测试': ['static', 'affected'], 'C|删除分支、清理工作树、汇报': ['cleanup', 'wrap-up'] };
  for (const r of rows) assert.deepEqual(r.ids, SHARED[`${r.stage}|${r.doc}`] ?? [r.ids[0]], `${r.stage}「${r.doc}」覆盖的工作编号：${r.ids}`);
  for (const r of rows) {
    const line = doc.split('\n').find((l) => l.startsWith(`| ${r.stage} ${r.stageName} | ${r.doc} |`));
    assert.ok(line, `process.md 环节表缺这一行：${r.stage} ${r.stageName} | ${r.doc}`);
    const cells = line.split('|').map((c) => c.trim());
    assert.ok(cells[3].includes(r.docWhere), `「${r.doc}」的去处栏应含「${r.docWhere}」：${cells[3]}`);
    for (const phrase of r.must) assert.ok(cells[3].includes(phrase), `「${r.doc}」的去处栏应含关键短语「${phrase}」：${cells[3]}`);
    assert.equal(cells[4], r.who, `「${r.doc}」的谁定栏应是「${r.who}」`);
  }
  // 同一批关键短语也必须出现在代码给出的理由里（用带外部执行器和 CI 的环境，覆盖所有条件分支的工作）
  for (const env of [{ fullTests: 'local', reviewFlow: 'pre-push', externalExecutor: true }, { ...PR, externalExecutor: true }]) {
    for (const stage of STAGE_IDS) {
      for (const d of decideStage(stage, env).items) {
        const r = rows.find((x) => x.stage === stage && x.ids.includes(d.id));
        for (const phrase of r.must) assert.ok(d.reason.includes(phrase), `${stage}/${d.id} 的理由应含关键短语「${phrase}」：${d.reason}`);
      }
    }
  }
  // 反过来：文档表里的环节行不能比代码多（多了说明代码里删了工作而文档没改）
  const docRowsInDoc = doc.split('\n').filter((l) => /^\| [ABCW] (推送前|PR 阶段|合并与收尾|每周巡检) \|/.test(l));
  assert.equal(docRowsInDoc.length, new Set(rows.map((r) => `${r.stage}|${r.doc}`)).size, '文档里的行数与代码里的工作行数相同');
});

test('planFromArgs：基准提交上的策略与工作区的非策略字段拼出不成立的组合时报错，不输出前后矛盾的计划', () => {
  const root = tmpRepo();
  write(root, 'engineering.config.json', cfg({ reviewFlow: 'pr', fullTests: 'ci', ciRunner: 'self-hosted', requiredChecks: ['ci-gate'] }));
  commitAll(root, 'base');
  git(root, ['checkout', '-q', '-b', 'feat']);
  // 工作区：主用改成托管、后备设成自托管（单看合法）；基准上的主用仍是自托管，拼起来后备与主用相同
  write(root, 'engineering.config.json', cfg({ reviewFlow: 'pr', fullTests: 'ci', ciRunner: 'github-hosted', ciFallback: 'self-hosted', requiredChecks: ['ci-gate'] }));
  assert.throws(() => planFromArgs(['--stage', 'B', '--target', root, '--choice', 'tight=false', '--choice', 'hasServer=true']), /环境取值不成立.*ciFallback/s);
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
