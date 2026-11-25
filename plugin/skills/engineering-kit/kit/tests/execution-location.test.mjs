// 执行位置选项测试（modules.gate.fullTests / ciRunner）：全量测试交给本机（local，默认）还是 CI（ci），CI 放在哪里。
// 业务含义：选 ci 时闸门只做静态检查，推送核对不要求本机测试记录，全量由 CI 在最终提交上跑、merge.mjs 合并前核对；
// 所以 ci 必须搭配 pr 流程和已声明的 CI，两项又是判定策略字段，分支不能自己改成 ci 来绕过本机测试记录。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, normalizeConfig, toFlat, toProfile } from '../gate/config.mjs';
import { runGate } from '../gate/gate.mjs';
import { POLICY_KEYS, loadConfig, readRecord } from '../gate/lib.mjs';
import { mergePr } from '../gate/merge.mjs';
import { recordReview } from '../gate/review.mjs';
import { verify } from '../gate/verify.mjs';
import { commitAll, featureRepo, git, reportFile, SRC_HEADER, TEST_CONFIG, tmpRepo, write } from './helpers.mjs';

/** ci 模式的合法配置片段。 */
const CI = { reviewFlow: 'pr', fullTests: 'ci', ciRunner: 'github-hosted', requiredChecks: ['test'] };

/** 在功能分支上改 dedup（源文件与带断言的测试一起改）并提交。 */
function changeDedup(root, tag = 'sorted') {
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return [...new Set(items)].sort(); // ${tag}\n}\n`);
  write(root, 'test/dedup.test.ts', `import { dedup } from '../src/dedup.ts';\nassert.ok(dedup, '${tag}');\n`);
  commitAll(root, `feat ${tag}`);
}

/** profile 结构的配置，只改 gate 段。 */
const profile = (gate) => ({ profile: 2, modules: { gate } });

test('配置：fullTests 默认 local，ciRunner 默认不声明；取值只认约定的几个', () => {
  assert.equal(DEFAULTS.fullTests, 'local');
  assert.equal(DEFAULTS.ciRunner, null);
  const eff = normalizeConfig({ profile: 2 });
  assert.equal(eff.fullTests, 'local');
  assert.equal(eff.ciRunner, null);
  assert.equal(normalizeConfig({}).fullTests, 'local', '旧版扁平配置没有这两项时按默认');
  for (const runner of ['github-hosted', 'self-hosted', 'none']) {
    assert.equal(normalizeConfig(profile({ ciRunner: runner })).ciRunner, runner);
  }
  assert.throws(() => normalizeConfig(profile({ fullTests: 'cloud' })), /fullTests/);
  assert.throws(() => normalizeConfig(profile({ ciRunner: 'gitlab' })), /ciRunner/);
  assert.throws(() => normalizeConfig({ fullTests: 'CI' }), /fullTests/);
});

test('配置：fullTests 为 ci 须搭配 pr 流程和已声明的 CI（github-hosted 或 self-hosted）', () => {
  assert.equal(normalizeConfig(profile({ ...CI })).fullTests, 'ci');
  assert.equal(normalizeConfig(profile({ ...CI, ciRunner: 'self-hosted' })).ciRunner, 'self-hosted');
  assert.throws(() => normalizeConfig(profile({ ...CI, reviewFlow: 'pre-push' })), /pr 流程/, 'pre-push 流程不核对 CI，全量没有强制执行点');
  assert.throws(() => normalizeConfig(profile({ fullTests: 'ci', reviewFlow: 'pr' })), /ciRunner/, '没声明 CI');
  assert.throws(() => normalizeConfig(profile({ ...CI, ciRunner: 'none' })), /ciRunner/, '声明了没有 CI');
  // local 时 ciRunner 只是声明，任何合法值都行
  assert.equal(normalizeConfig(profile({ fullTests: 'local', ciRunner: 'none' })).ciRunner, 'none');
});

test('配置：两项是判定策略字段；toProfile 与 toFlat 往返不丢失，默认值时 ciRunner 不凭空多出来', () => {
  assert.ok(POLICY_KEYS.includes('fullTests'), '全量测试交给谁决定推送核对要不要测试记录，分支不能自己改');
  assert.ok(POLICY_KEYS.includes('ciRunner'));
  const prof = toProfile({ ...CI });
  assert.equal(prof.modules.gate.fullTests, 'ci');
  assert.equal(prof.modules.gate.ciRunner, 'github-hosted');
  const flat = toFlat(prof);
  assert.equal(flat.fullTests, 'ci');
  assert.equal(flat.ciRunner, 'github-hosted');
  assert.deepEqual(toProfile(flat).modules.gate, prof.modules.gate);
  assert.equal('ciRunner' in toProfile({}).modules.gate, false);
  assert.equal(toProfile({}).modules.gate.fullTests, 'local');
});

test('策略：分支把 fullTests 改成 ci 不生效，推送核对仍要求测试记录；主干上合入后才生效', () => {
  const root = featureRepo(); // 主干上是默认的 local 与 pre-push
  write(root, 'engineering.config.json', JSON.stringify({ ...TEST_CONFIG, ...CI }, null, 2));
  changeDedup(root);
  const cfg = loadConfig(root);
  assert.equal(cfg.fullTests, 'local');
  assert.equal(cfg.reviewFlow, 'pre-push');
  assert.match(cfg.notes.join('\n'), /fullTests/);
  assert.equal(verify({ root }).ok, false, '分支自己改成 ci 不能绕过测试记录');
});

test('闸门：ci 模式只做静态检查，不跑测试命令、不写测试记录，输出写明交给 CI', () => {
  const root = featureRepo({ ...CI, testCommand: 'node fail.mjs' }); // 测试命令会失败：跑了就会暴露
  changeDedup(root);
  const res = runGate({ root });
  assert.equal(res.ok, true, res.messages.join('\n'));
  assert.equal(res.record, null);
  assert.equal(readRecord(root, 'tests.json'), null);
  const text = res.messages.join('\n');
  assert.match(text, /测试先行检查通过/);
  assert.match(text, /全量测试交给 CI/);
  assert.match(text, /fullTests/);
});

test('闸门：ci 模式静态检查不过照样不通过', () => {
  const root = featureRepo({ ...CI });
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return items;\n}\n`);
  commitAll(root, 'src only');
  const res = runGate({ root });
  assert.equal(res.ok, false);
  assert.match(res.messages.join('\n'), /静态检查未通过/);
});

test('闸门：ci 模式加 full 在本机跑全量并写记录（失败照样不通过）', () => {
  const root = featureRepo({ ...CI, testCommand: 'node fail.mjs' });
  changeDedup(root);
  const res = runGate({ root, full: true });
  assert.equal(res.ok, false);
  assert.equal(res.record.mode, 'full');
  assert.equal(readRecord(root, 'tests.json').passed, false);

  const ok = featureRepo({ ...CI });
  changeDedup(ok);
  const pass = runGate({ root: ok, full: true });
  assert.equal(pass.ok, true, pass.messages.join('\n'));
  assert.equal(pass.record.mode, 'full');
});

test('闸门：local 模式行为不变（默认跑全量），full 参数无影响', () => {
  const root = featureRepo({ testCommand: 'node fail.mjs' });
  changeDedup(root);
  assert.equal(runGate({ root }).ok, false);
  const ok = featureRepo();
  changeDedup(ok);
  const res = runGate({ root: ok, full: true });
  assert.equal(res.ok, true);
  assert.equal(res.record.mode, 'full');
});

test('推送核对：ci 模式没有任何测试记录也放行；静态检查、未提交改动照常拦；local 模式仍要求记录', () => {
  const root = featureRepo({ ...CI });
  changeDedup(root);
  assert.equal(readRecord(root, 'tests.json'), null);
  const res = verify({ root });
  assert.equal(res.ok, true, JSON.stringify(res.problems));
  assert.ok(!res.problems.some((p) => /测试记录/.test(p)));

  // 范围内有未提交改动：照常拦
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return [];\n}\n`);
  const dirty = verify({ root });
  assert.equal(dirty.ok, false);
  assert.ok(dirty.problems.some((p) => /未提交/.test(p)), dirty.problems.join('\n'));
  git(root, ['checkout', '--', 'src/dedup.ts']);

  // 新增源文件而没有测试：测试先行照常拦
  write(root, 'src/rank.ts', `${SRC_HEADER}export function rank(n: number) {\n  return n;\n}\n`);
  commitAll(root, 'no test');
  const noTest = verify({ root });
  assert.equal(noTest.ok, false);
  assert.ok(noTest.problems.some((p) => /rank\.ts/.test(p)), noTest.problems.join('\n'));

  // local（默认）：没有测试记录就拦
  const local = featureRepo({ reviewFlow: 'pr' });
  changeDedup(local);
  const blocked = verify({ root: local });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.problems.some((p) => /没有测试记录/.test(p)), blocked.problems.join('\n'));
});

test('模板与说明：配置模板写明两项，默认 local；说明里讲清 ci 的前提', () => {
  const tpl = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'templates', 'engineering.config.json'), 'utf8'));
  assert.equal(tpl.modules.gate.fullTests, 'local');
  assert.match(tpl._说明, /fullTests/);
  assert.match(tpl._说明, /ciRunner/);
  assert.equal(normalizeConfig(tpl).fullTests, 'local');
});

test('配置：fullTests 为 ci 须在 requiredChecks 里写明跑全量的检查（空表示每项检查都必需，一个只跑 lint 的 CI 也会放行）', () => {
  assert.throws(() => normalizeConfig(profile({ reviewFlow: 'pr', fullTests: 'ci', ciRunner: 'github-hosted' })), /requiredChecks/);
  assert.throws(() => normalizeConfig(profile({ reviewFlow: 'pr', fullTests: 'ci', ciRunner: 'github-hosted', requiredChecks: [] })), /requiredChecks/);
  assert.equal(normalizeConfig(profile({ ...CI })).requiredChecks[0], 'test');
});

test('闸门：ci 模式下只有脚手架（没有源码与测试）时也不写测试记录；显式 full 才写“无需测试”记录', () => {
  const root = tmpRepo();
  write(root, 'engineering.config.json', JSON.stringify({ ...TEST_CONFIG, ...CI }, null, 2));
  write(root, 'README.md', '# scaffold\n');
  commitAll(root, 'base');
  git(root, ['checkout', '-q', '-b', 'feat']);
  write(root, 'NOTES.md', '# notes\n');
  commitAll(root, 'scaffold only');
  const res = runGate({ root });
  assert.equal(res.ok, true, res.messages.join('\n'));
  assert.equal(res.record, null);
  assert.equal(readRecord(root, 'tests.json'), null, 'ci 模式默认不写测试记录');
  const full = runGate({ root, full: true });
  assert.equal(full.ok, true, full.messages.join('\n'));
  assert.equal(full.record?.skipped, 'no-code');
});

test('闸门：ci 模式加 force 也在本机重跑全量；默认的静态检查仍做源码与测试 glob 误配检查', () => {
  const root = featureRepo({ ...CI });
  changeDedup(root);
  const forced = runGate({ root, force: true });
  assert.equal(forced.ok, true, forced.messages.join('\n'));
  assert.equal(forced.record.mode, 'full');

  // glob 写错（JS 项目沿用默认的 ts glob）：有代码文件却没有任何文件匹配，不能当成“交给 CI”放过
  const bad = featureRepo({ ...CI, sourceGlobs: ['nothing/**/*.ts'], testGlobs: ['nothing/**/*.test.ts'] });
  write(bad, 'lib/a.js', `${SRC_HEADER}export const a = 1;\n`);
  commitAll(bad, 'js');
  const res = runGate({ root: bad });
  assert.equal(res.ok, false, res.messages.join('\n'));
  assert.match(res.messages.join('\n'), /sourceGlobs|没有任何文件匹配/);
});

test('合并入口：ci 模式本机没有测试记录，最终提交上缺少必需的全量检查或它没成功时不能合并；齐了才合并', () => {
  const root = featureRepo(CI);
  changeDedup(root);
  assert.equal(runGate({ root }).ok, true);
  assert.equal(readRecord(root, 'tests.json'), null, 'ci 模式本机不写测试记录');
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const report = reportFile('范围：读了 dedup 函数、调用方和对应测试。\n发现：无高、中级问题。\n已逐条核对 PR 的最终提交，dedup 函数与测试用例的边界条件（空数组、重复项）均有覆盖。\n处置：无需处理。\n作者的验证：核对了作者给出的测试输出，没有重跑。\n结论\n通过\n');
  const view = (checks) => ({ state: 'OPEN', headRefOid: head, statusCheckRollup: checks, files: [{ path: 'src/dedup.ts', additions: 1, deletions: 0 }, { path: 'test/dedup.test.ts', additions: 1, deletions: 0 }] });
  const gh = (v) => {
    const calls = [];
    const f = (args) => {
      calls.push(args);
      return args[1] === 'view' ? { status: 0, stdout: JSON.stringify(v), stderr: '' } : { status: 0, stdout: '', stderr: '' };
    };
    f.calls = calls;
    return f;
  };
  const full = { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' };
  const lint = { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' };
  for (const kind of ['code', 'consistency']) {
    const r = recordReview({ root, verdict: 'pass', pr: '7', kind, gh: gh(view([full, lint])), reviewer: 'feature-dev:code-reviewer', reportPath: report, summary: 's' });
    assert.equal(r.ok, true, r.message);
  }
  for (const [checks, why] of [
    [[lint], /必需检查没有出现在 PR 上：test/],
    [[{ ...full, conclusion: 'SKIPPED' }, lint], /必需检查没有成功：test/],
    [[{ ...full, conclusion: 'FAILURE' }, lint], /CI 检查未通过：test/],
  ]) {
    const g = gh(view(checks));
    const res = mergePr({ root, pr: '7', gh: g });
    assert.equal(res.ok, false, JSON.stringify(checks));
    assert.match(JSON.stringify(res.problems), why);
    assert.equal(g.calls.some((a) => a[1] === 'merge'), false, '不得调用合并');
  }
  const ok = gh(view([full, lint]));
  const res = mergePr({ root, pr: '7', gh: ok });
  assert.equal(res.ok, true, JSON.stringify(res.problems));
  assert.ok(ok.calls.some((a) => a[1] === 'merge'));
});
