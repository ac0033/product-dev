// 环境选项测试：装套件时按用户的实际情况选执行位置（全量测试在哪跑、CI 放哪、CI 系统、会话与并行偏好）。
// 业务含义：用户有想法按用户的；没选或不知道怎么选时，由 tools/environment.mjs 按“本机实际情况”和“更快、更便宜、更高效、更准确”
// 两条原则推荐；选定后写进项目配置，并按选择生成对应的 CI 工作流。这里覆盖推荐、冲突检查、工作流生成与同步安装。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { normalizeConfig } from '../gate/config.mjs';
import { applyEnvironment, describeEnvironment, detectFacts, recommend, renderCiWorkflow, resolveEnvironment } from '../tools/environment.mjs';
import { BUNDLE_ROOT, syncKit } from '../sync.mjs';
import { PRESETS } from '../tools/presets.mjs';
import { read, tmpDir, tmpRepo, write } from './helpers.mjs';

/** 资源紧张的 Windows 笔记本，有 GitHub 远程。 */
const LAPTOP = { os: 'windows', cpus: 4, memGB: 8, githubRemote: true, ghAvailable: true };
/** 资源充裕的 Linux 工作站，没有 GitHub，也没有 gh。 */
const WORKSTATION = { os: 'linux', cpus: 16, memGB: 64, githubRemote: false, ghAvailable: false };

test('推荐：有 GitHub 的资源紧张机器 → 全量交给 CI（pr 流程、GitHub 托管、只 Linux、云端会话、并行），每项带理由', () => {
  const r = recommend(LAPTOP);
  assert.equal(r.values.fullTests, 'ci');
  assert.equal(r.values.reviewFlow, 'pr');
  assert.equal(r.values.ciRunner, 'github-hosted');
  assert.deepEqual(r.values.ciOs, ['linux']);
  assert.equal(r.values.session, 'cloud');
  assert.equal(r.values.parallel, 'parallel');
  assert.deepEqual(r.conflicts, []);
  for (const k of ['fullTests', 'ciRunner', 'ciOs', 'session', 'parallel']) assert.ok(r.reasons[k] && r.reasons[k].length > 5, `${k} 缺理由`);
  assert.match(r.reasons.fullTests, /更快/);
  assert.match(r.reasons.ciOs, /Windows.*2 倍|2 倍/);
});

test('推荐：资源充裕且没有 GitHub → 全量在本机跑、本地会话、并行', () => {
  const r = recommend(WORKSTATION);
  assert.equal(r.values.fullTests, 'local');
  assert.equal(r.values.reviewFlow, 'pre-push');
  assert.equal(r.values.ciRunner, null);
  assert.equal(r.values.session, 'local');
  assert.equal(r.values.parallel, 'parallel');
});

test('推荐：资源紧张、没有 GitHub、又要在本机跑全量时串行；放到云端会话则可以并行', () => {
  const tight = { os: 'linux', cpus: 2, memGB: 4, githubRemote: false, ghAvailable: false };
  assert.equal(recommend(tight, { session: 'local' }).values.parallel, 'serial');
  assert.equal(recommend(tight, { session: 'cloud' }).values.parallel, 'parallel');
  assert.equal(recommend(tight).values.session, 'cloud', '资源紧张时重复性工作推荐放云端');
});

test('推荐：用户的选择一律优先，推荐只补没选的项', () => {
  const r = recommend(LAPTOP, { fullTests: 'local', session: 'local', parallel: 'serial', ciOs: ['linux', 'windows'] });
  assert.equal(r.values.fullTests, 'local');
  assert.equal(r.values.reviewFlow, 'pre-push');
  assert.equal(r.values.session, 'local');
  assert.equal(r.values.parallel, 'serial');
  assert.deepEqual(r.values.ciOs, ['linux', 'windows']);
  assert.equal(r.sources.fullTests, 'user');
  assert.equal(recommend(LAPTOP).sources.fullTests, 'recommended');
});

test('推荐：产品要在 Windows、macOS 上运行时，CI 系统在 Linux 之外加上它们（更准确）', () => {
  const r = recommend(LAPTOP, { targets: ['windows', 'macos'] });
  assert.deepEqual(r.values.ciOs, ['linux', 'windows', 'macos']);
  assert.match(r.reasons.ciOs, /准确/);
});

test('推荐：有服务器时 GitHub 托管优先、自托管作后备；没服务器却选自托管是冲突', () => {
  const withServer = recommend(LAPTOP, { hasServer: true });
  assert.equal(withServer.values.ciRunner, 'github-hosted');
  assert.equal(withServer.values.ciFallback, 'self-hosted');
  const noServer = recommend(LAPTOP, { hasServer: false, ciRunner: 'self-hosted' });
  assert.ok(noServer.conflicts.some((c) => /服务器/.test(c)), noServer.conflicts.join('\n'));
  const selfFirst = recommend(LAPTOP, { hasServer: true, ciRunner: 'self-hosted' });
  assert.equal(selfFirst.values.ciFallback, 'github-hosted', '主用自托管时后备取 GitHub 托管');
});

test('推荐：没有服务器却把自托管设成后备也是冲突；resolveEnvironment 不论推荐与否都拦下', () => {
  assert.ok(recommend(LAPTOP, { hasServer: false, ciFallback: 'self-hosted' }).conflicts.some((c) => /服务器/.test(c)));
  const root = tmpRepo();
  assert.throws(() => resolveEnvironment(root, { recommended: false, choices: { ciRunner: 'self-hosted', hasServer: false, fullTests: 'local' } }, LAPTOP), /服务器/);
  assert.throws(() => resolveEnvironment(root, { recommended: true, choices: { ciFallback: 'self-hosted', hasServer: false } }, LAPTOP), /服务器/);
  assert.doesNotThrow(() => resolveEnvironment(root, { recommended: false, choices: { reviewFlow: 'pre-push' } }, LAPTOP), '只给一项时不拿推荐值制造冲突');
});

test('推荐：冲突不静默改——fullTests=ci 配 pre-push 流程、或 ci 却没有 CI，都列为冲突', () => {
  assert.ok(recommend(LAPTOP, { fullTests: 'ci', reviewFlow: 'pre-push' }).conflicts.some((c) => /pr 流程/.test(c)));
  assert.ok(recommend(LAPTOP, { fullTests: 'ci', ciRunner: 'none' }).conflicts.some((c) => /ciRunner/.test(c)));
});

test('detectFacts：读本机系统、资源与 GitHub 远程；可注入覆盖值', () => {
  const root = tmpRepo();
  const f = detectFacts(root, { os: 'macos', cpus: 8, memGB: 16, ghAvailable: false });
  assert.equal(f.os, 'macos');
  assert.equal(f.cpus, 8);
  assert.equal(f.githubRemote, false, '没有远程');
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/a/b.git'], { cwd: root });
  assert.equal(detectFacts(root, { ghAvailable: false }).githubRemote, true);
  assert.equal(detectFacts(root, { ghAvailable: true }).ghAvailable, true, 'ghAvailable 指 gh 已登录（装了没登录不算）');
  const real = detectFacts(root);
  assert.ok(['linux', 'windows', 'macos'].includes(real.os));
  assert.ok(real.cpus >= 1 && real.memGB > 0);
});

test('说明：按系统写命令写法，按选择写做法', () => {
  const lines = describeEnvironment(recommend(LAPTOP).values, LAPTOP).join('\n');
  assert.match(lines, /PowerShell/);
  assert.match(lines, /CI/);
  assert.match(lines, /云端会话/);
  assert.match(describeEnvironment(recommend(WORKSTATION).values, WORKSTATION).join('\n'), /bash|shell/i);
});

/** 渲染工作流用的取值。 */
const WF = { ciRunner: 'github-hosted', ciFallback: null, ciOs: ['linux'], testCommand: 'npm test', reviewIgnore: ['docs/**/*.md', 'README.md'] };

test('工作流：草稿 PR 不跑、只改文档跳过但汇总检查仍成功、同一 PR 取消旧运行、汇总检查叫 ci-gate', () => {
  const y = renderCiWorkflow(WF);
  assert.match(y, /ready_for_review/);
  assert.match(y, /github\.event\.pull_request\.draft != true/);
  assert.match(y, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  assert.match(y, /group: ci-\$\{\{ github\.event\.pull_request\.number \|\| github\.sha \}\}/, '推送到 main 每次一组，排队中的运行不会被后一次推送顶掉');
  assert.match(y, /git diff --no-renames --name-only/, '改名按旧路径删除加新路径新增算，源码改名进 docs 不会被当成只改文档');
  assert.match(y, /ci-gate:\n\s+name: ci-gate/);
  assert.match(y, /if: always\(\)/);
  assert.match(y, /runs-on: ubuntu-latest/);
  assert.match(y, /run: npm test/);
  assert.match(y, /setup-node/);
  assert.ok(!/windows-latest|macos-latest/.test(y));
  // 只改文档的判断：glob 转成 shell 的 case 模式
  assert.match(y, /docs\/\*\.md\|README\.md\)/);
  assert.ok(!/\t/.test(y));
});

test('工作流：按选择生成——多系统矩阵、自托管后备用仓库变量切换、Python 栈、没有免审文档时总是跑', () => {
  const multi = renderCiWorkflow({ ...WF, ciOs: ['linux', 'windows', 'macos'] });
  assert.match(multi, /os: windows\n\s+runner: windows-latest/);
  assert.match(multi, /os: macos\n\s+runner: macos-latest/);
  const fb = renderCiWorkflow({ ...WF, ciFallback: 'self-hosted' });
  assert.match(fb, /vars\.CI_RUNNER == 'self-hosted' && github\.event\.pull_request\.head\.repo\.fork != true && fromJSON\('\["self-hosted","linux"\]'\) \|\| 'ubuntu-latest'/, '自托管只给仓库自己的提交和 PR，fork 的 PR 一律走托管 runner；带 linux 标签，不会被 Windows 自托管机接走');
  const selfFirst = renderCiWorkflow({ ...WF, ciRunner: 'self-hosted', ciFallback: 'github-hosted' });
  assert.match(selfFirst, /\(vars\.CI_RUNNER == 'github-hosted' \|\| github\.event\.pull_request\.head\.repo\.fork == true\) && 'ubuntu-latest' \|\| fromJSON\('\["self-hosted","linux"\]'\)/);
  const selfOnly = renderCiWorkflow({ ...WF, ciRunner: 'self-hosted' });
  assert.match(selfOnly, /runner: \$\{\{ github\.event\.pull_request\.head\.repo\.fork == true && 'ubuntu-latest' \|\| fromJSON\('\["self-hosted","linux"\]'\) \}\}/);
  assert.match(selfOnly, /不要把自托管 runner 用在接受外部 PR 的公开仓库/, '说明自托管 runner 的安全风险');
  const py = renderCiWorkflow({ ...WF, testCommand: 'python -m pytest -q' });
  assert.match(py, /setup-python/);
  assert.match(py, /run: python -m pip install pytest/, '干净环境里先装 pytest');
  assert.ok(!/setup-node/.test(py));
  const none = renderCiWorkflow({ ...WF, reviewIgnore: [] });
  assert.match(none, /code=true/);
  assert.ok(!/case "\$f" in/.test(none), '没有免审文档时不生成 case 判断');
});

test('应用到配置：写入 gate 与 environment，并把汇总检查列为必需检查；不改入参', () => {
  const tpl = JSON.parse(fs.readFileSync(path.join(BUNDLE_ROOT, 'kit', 'templates', 'engineering.config.json'), 'utf8'));
  const before = JSON.stringify(tpl);
  const out = applyEnvironment(tpl, { ...recommend(LAPTOP, { hasServer: true }).values }, { requiredChecks: ['ci-gate'] });
  assert.equal(JSON.stringify(tpl), before);
  const eff = normalizeConfig(out);
  assert.equal(eff.fullTests, 'ci');
  assert.equal(eff.reviewFlow, 'pr');
  assert.equal(eff.ciFallback, 'self-hosted');
  assert.equal(eff.session, 'cloud');
  assert.deepEqual(eff.requiredChecks, ['ci-gate']);
});

test('resolveEnvironment：推荐模式补全没选的项；只给选择时只写给出的项', () => {
  const root = tmpRepo();
  const rec = resolveEnvironment(root, { recommended: true, choices: { ciOs: ['linux', 'windows'] } }, LAPTOP);
  assert.equal(rec.values.fullTests, 'ci');
  assert.deepEqual(rec.values.ciOs, ['linux', 'windows']);
  const only = resolveEnvironment(root, { recommended: false, choices: { fullTests: 'local' } }, LAPTOP);
  assert.deepEqual(only.values, { fullTests: 'local' });
  assert.throws(() => resolveEnvironment(root, { recommended: false, choices: { fullTests: 'ci' } }, LAPTOP), /pr 流程|ciRunner/);
});

/** 在空目录里用 ts 预设首次安装。 */
function install(extra = {}) {
  const dir = path.join(tmpDir('ekit-env-'), 'proj');
  const r = syncKit({ target: dir, init: true, preset: PRESETS.ts, ...extra });
  return { dir, r };
}

test('同步：首次安装带环境选择 → 配置按选择写好，生成 ci.yml，必需检查是 ci-gate，整包漂移检查无差异', () => {
  const env = { values: recommend(LAPTOP, { hasServer: true }).values, facts: LAPTOP };
  const { dir, r } = install({ env });
  assert.equal(r.ok, true, r.messages.join('\n'));
  const cfg = JSON.parse(read(dir, 'engineering.config.json'));
  assert.equal(cfg.modules.gate.fullTests, 'ci');
  assert.equal(cfg.modules.gate.reviewFlow, 'pr');
  assert.equal(cfg.modules.gate.ciFallback, 'self-hosted');
  assert.deepEqual(cfg.modules.gate.requiredChecks, ['ci-gate']);
  assert.equal(cfg.modules.environment.session, 'cloud');
  const yml = read(dir, '.github/workflows/ci.yml');
  assert.match(yml, /run: npm test/);
  assert.match(yml, /vars\.CI_RUNNER/);
  assert.ok(r.messages.some((m) => /CI/.test(m) && /云端会话/.test(m)), r.messages.join('\n'));
  assert.equal(syncKit({ target: dir, dryRun: true }).conflicts.length, 0);
});

test('同步：已有配置时环境选择不生效（只提示）；已有 ci.yml 不覆盖、不擅自设必需检查', () => {
  const dir = path.join(tmpDir('ekit-env-'), 'proj');
  assert.equal(syncKit({ target: dir, init: true, preset: PRESETS.ts }).ok, true);
  const env = { values: recommend(LAPTOP).values, facts: LAPTOP };
  const again = syncKit({ target: dir, env });
  assert.ok(again.messages.some((m) => /已存在.*首次/.test(m)), again.messages.join('\n'));
  assert.equal(JSON.parse(read(dir, 'engineering.config.json')).modules.gate.fullTests, 'local');
  assert.ok(!fs.existsSync(path.join(dir, '.github/workflows/ci.yml')));

  const dir2 = path.join(tmpDir('ekit-env-'), 'proj');
  fs.mkdirSync(path.join(dir2, '.github/workflows'), { recursive: true });
  write(dir2, '.github/workflows/ci.yml', 'name: mine\n');
  // 已有 ci.yml：套件不能确认它跑全量测试，fullTests=ci 时必须由用户写明哪些必需检查跑全量，否则拒绝安装
  assert.throws(() => syncKit({ target: dir2, init: true, preset: PRESETS.ts, env }), /requiredChecks/);
  assert.ok(!fs.existsSync(path.join(dir2, 'engineering.config.json')), '拒绝时不留半成品');
  const named = { values: { ...env.values, requiredChecks: ['unit (ubuntu-latest)'] }, facts: LAPTOP };
  const r = syncKit({ target: dir2, init: true, preset: PRESETS.ts, env: named });
  assert.equal(r.ok, true, r.messages.join('\n'));
  assert.equal(read(dir2, '.github/workflows/ci.yml'), 'name: mine\n');
  assert.deepEqual(JSON.parse(read(dir2, 'engineering.config.json')).modules.gate.requiredChecks, ['unit (ubuntu-latest)']);
  assert.ok(r.messages.some((m) => /ci\.yml/.test(m)), r.messages.join('\n'));
  // fullTests=local 时已有 ci.yml 不受影响
  const dir3 = path.join(tmpDir('ekit-env-'), 'proj');
  write(dir3, '.github/workflows/ci.yml', 'name: mine\n');
  assert.equal(syncKit({ target: dir3, init: true, preset: PRESETS.ts, env: { values: { fullTests: 'local', ciRunner: 'github-hosted' }, facts: LAPTOP } }).ok, true);
});

test('命令行：environment.mjs detect 输出事实与推荐（JSON），--choice 覆盖；sync.mjs --env recommended 能装', () => {
  const root = tmpRepo();
  const out = spawnSync(process.execPath, [path.join(BUNDLE_ROOT, 'kit', 'tools', 'environment.mjs'), 'detect', '--target', root, '--choice', 'fullTests=local', '--choice', 'session=cloud'], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const j = JSON.parse(out.stdout);
  assert.equal(j.recommendation.values.fullTests, 'local');
  assert.equal(j.recommendation.values.session, 'cloud');
  assert.ok(j.facts.os);
  const bad = spawnSync(process.execPath, [path.join(BUNDLE_ROOT, 'kit', 'tools', 'environment.mjs'), 'detect', '--target', root, '--choice', 'fullTests=cloud'], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);

  const dir = path.join(tmpDir('ekit-env-'), 'proj');
  const s = spawnSync(process.execPath, [path.join(BUNDLE_ROOT, 'kit', 'sync.mjs'), '--target', dir, '--init', '--profile', 'ts', '--env', 'recommended', '--choice', 'fullTests=local'], { encoding: 'utf8' });
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.equal(JSON.parse(read(dir, 'engineering.config.json')).modules.gate.fullTests, 'local');
  // --env 漏填值（写在命令末尾，或后面直接跟别的选项）不能静默按默认安装
  const dir2 = path.join(tmpDir('ekit-env-'), 'proj');
  for (const args of [['--env'], ['--env', '--choice', 'fullTests=local']]) {
    const miss = spawnSync(process.execPath, [path.join(BUNDLE_ROOT, 'kit', 'sync.mjs'), '--target', dir2, '--init', '--profile', 'ts', ...args], { encoding: 'utf8' });
    assert.notEqual(miss.status, 0, args.join(' '));
    assert.match(miss.stderr, /--env/);
  }
  assert.ok(!fs.existsSync(path.join(dir2, 'engineering.config.json')));
});
