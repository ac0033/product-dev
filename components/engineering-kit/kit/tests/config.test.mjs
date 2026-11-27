// 配置 profile 测试：engineering.config.json 的四段结构（modules、layout、hygiene、rules）与旧的扁平结构互转。
// 业务含义：项目配置是唯一由项目维护的文件，结构要稳定、可升级；旧版扁平配置必须仍能读取（回滚与迁移都依赖它）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS, normalizeConfig, toFlat, toProfile, FLAT_KEYS } from '../gate/config.mjs';
import { POLICY_KEYS } from '../gate/lib.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'engineering.config.json');

test('profile：四段结构展开为闸门使用的扁平字段', () => {
  const eff = normalizeConfig({
    profile: 2,
    modules: {
      gate: { base: 'origin/dev', testCommand: 'npm test', testEnv: { A: '1' }, lockMaxAgeMinutes: 30 },
      review: { reviewers: ['feature-dev:code-reviewer'], reviewMinChars: 80, reviewKeyword: '结论' },
    },
    layout: { sourceGlobs: ['src/**/*.ts'], testGlobs: ['test/**/*.ts'], stages: ['01-原型'], topLevelAllowed: ['src'] },
    hygiene: { bannedNameTokens: ['copy'], staleDraftDays: 14 },
    rules: { reviewIgnore: ['**/*.md'], commentMode: 'header' },
  });
  assert.equal(eff.base, 'origin/dev');
  assert.equal(eff.testCommand, 'npm test');
  assert.deepEqual(eff.testEnv, { A: '1' });
  assert.equal(eff.lockMaxAgeMinutes, 30);
  assert.deepEqual(eff.sourceGlobs, ['src/**/*.ts']);
  assert.deepEqual(eff.reviewers, ['feature-dev:code-reviewer']);
  assert.equal(eff.reviewMinChars, 80);
  assert.deepEqual(eff.reviewIgnore, ['**/*.md']);
  assert.equal(eff.commentMode, 'header');
  assert.deepEqual(eff.hygiene.bannedNameTokens, ['copy']);
  assert.deepEqual(eff.layout.stages, ['01-原型']);
});

test('旧版扁平配置仍可读取（回滚到旧版本时需要）', () => {
  const eff = normalizeConfig({ base: 'main', sourceGlobs: ['src/**/*.py'], testCommand: 'node pass.mjs' });
  assert.equal(eff.base, 'main');
  assert.deepEqual(eff.sourceGlobs, ['src/**/*.py']);
  assert.equal(eff.commentMode, 'header+exports', '缺省值应补齐');
});

test('扁平 ⇄ profile 互转：字段不丢失', () => {
  const flat = {
    base: 'origin/main', sourceGlobs: ['src/**/*.ts'], testGlobs: ['tests/**/*.ts'], reviewIgnore: ['**/*.md'],
    commentMode: 'header', testCommand: 'npm test', testEnv: { X: 'y' }, reviewers: ['general-purpose'],
    reviewMinChars: 200, reviewSections: ['范围', '发现', '作者的验证'], reviewKeyword: '结论', lockMaxAgeMinutes: 90, reviewFlow: 'pr',
    // 0.6.0 新增的两个扁平字段
    testGroups: [{ name: 'unit', paths: ['src/**'], command: 'npm run test:unit' }], maxReviewRounds: 4,
    // 0.7.0 新增：pr 流程的必需检查名
    requiredChecks: ['test (ubuntu-latest)', 'lint'],
    // 0.7.0 新增：外部复审允许的执行器与外发前追加排除
    externalExecutors: ['codex'], externalExclude: ['config/*.secrets.yaml'],
    // 执行位置与环境选项：全量测试在哪跑、CI 放哪、CI 跑在哪些系统、会话与并行偏好
    fullTests: 'ci', ciRunner: 'github-hosted', ciFallback: 'self-hosted', ciOs: ['linux', 'windows'], session: 'cloud', parallel: 'parallel',
    // 测试度量新增的四个键（C2）：测试分层、JUnit 报告 glob、覆盖率、变异测试命令
    testLayers: [{ name: 'unit', paths: ['tests/unit/**'] }], testReports: ['reports/*.xml'], coverage: { command: 'npm run cov', lcov: 'coverage/lcov.info' }, mutationCommand: 'npx stryker run',
  };
  const prof = toProfile(flat);
  assert.equal(prof.profile, 2);
  assert.deepEqual(Object.keys(prof.modules).sort(), ['environment', 'gate', 'review'], '有非默认的环境选项时多一段 environment');
  const back = toFlat(prof);
  for (const k of FLAT_KEYS) assert.deepEqual(back[k], flat[k], `字段 ${k} 互转后不一致`);
});

test('回滚再升级：扁平结构里保存的布局与巡检设置原样恢复', () => {
  const prof = toProfile({ base: 'main', sourceGlobs: ['src/**/*.py'], testGlobs: [] });
  prof.layout.topLevelAllowed = ['docs', 'pdf'];
  prof.hygiene.staleDraftDays = 7;
  const flat = toFlat(prof);
  assert.equal(flat.profile, undefined, '扁平结构不含 profile 版本号');
  const again = toProfile(flat);
  assert.deepEqual(again.layout.topLevelAllowed, ['docs', 'pdf']);
  assert.equal(again.hygiene.staleDraftDays, 7);
  assert.deepEqual(again.layout.sourceGlobs, ['src/**/*.py']);
});

test('profile 结构错误：段不是对象时报错', () => {
  assert.throws(() => normalizeConfig({ profile: 2, modules: 'bad' }), /modules/);
  assert.throws(() => normalizeConfig({ profile: 3 }), /profile/);
});

test('模板文件本身是合法的 profile，并能展开', () => {
  const raw = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
  assert.equal(raw.profile, 2);
  const eff = normalizeConfig(raw);
  assert.equal(eff.base, 'auto');
  assert.ok(eff.sourceGlobs.length > 0);
});

test('默认复审者名单含插件自带的复审子代理 product-dev:code-reviewer，配置模板与默认值一致', () => {
  assert.ok(DEFAULTS.reviewers.includes('product-dev:code-reviewer'), JSON.stringify(DEFAULTS.reviewers));
  assert.ok(normalizeConfig({ profile: 2 }).reviewers.includes('product-dev:code-reviewer'));
  const template = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
  assert.deepEqual(template.modules.review.reviewers, DEFAULTS.reviewers);
  // 项目自己写了名单的不受默认值影响（老项目的配置不会被悄悄改掉）
  assert.deepEqual(normalizeConfig({ profile: 2, modules: { review: { reviewers: ['general-purpose'] } } }).reviewers, ['general-purpose']);
});

test('复审报告的格式检查：默认要求三节、不再按字数；旧配置的 reviewMinChars 照常读取', () => {
  assert.deepEqual(DEFAULTS.reviewSections, ['范围', '发现', '作者的验证']);
  assert.equal(DEFAULTS.reviewMinChars, 0);
  const template = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
  assert.deepEqual(template.modules.review.reviewSections, DEFAULTS.reviewSections, '配置模板与默认值一致');
  assert.equal(template.modules.review.reviewMinChars, undefined, '新项目的模板不再写最少字数');
  const old = normalizeConfig({ profile: 2, modules: { review: { reviewMinChars: 200 } } });
  assert.equal(old.reviewMinChars, 200);
  assert.deepEqual(old.reviewSections, DEFAULTS.reviewSections, '旧配置没写 reviewSections 时取默认');
  const prof = toProfile(old);
  assert.equal(prof.modules.review.reviewMinChars, 200, '显式的正数在互转中保留');
  assert.equal(toProfile(normalizeConfig({ profile: 2 })).modules.review.reviewMinChars, undefined, '默认的 0 不写进配置');
});

test('reviewSections 格式不对时报错；写成空数组表示不要求任何节', () => {
  assert.throws(() => normalizeConfig({ profile: 2, modules: { review: { reviewSections: '范围' } } }), /reviewSections/);
  assert.throws(() => normalizeConfig({ profile: 2, modules: { review: { reviewSections: ['范围', ''] } } }), /reviewSections/);
  assert.throws(() => normalizeConfig({ profile: 2, modules: { review: { reviewSections: ['范围', '范围'] } } }), /reviewSections/);
  assert.throws(() => normalizeConfig({ profile: 2, modules: { review: { reviewSections: [' 范围'] } } }), /reviewSections/, '首尾有空白的节名永远匹配不上');
  assert.throws(() => normalizeConfig({ profile: 2, modules: { review: { reviewSections: ['范围' + String.fromCharCode(10)] } } }), /reviewSections/);
  assert.deepEqual(normalizeConfig({ profile: 2, modules: { review: { reviewSections: [] } } }).reviewSections, []);
});

test('回滚到扁平格式：默认的 reviewMinChars 0 不写出去（旧版用自己的默认字数），显式的正数保留', () => {
  assert.equal('reviewMinChars' in toFlat(normalizeConfig({ profile: 2 })), false);
  assert.equal(toFlat(normalizeConfig({ profile: 2, modules: { review: { reviewMinChars: 150 } } })).reviewMinChars, 150);
});

test('N4 显式写了 reviewMinChars: 0 的项目：回滚到扁平格式保留这个 0（旧版同样按 0 不检查），再升级也不丢', () => {
  const explicit = { profile: 2, modules: { review: { reviewMinChars: 0 } } };
  assert.equal(toFlat(explicit).reviewMinChars, 0, '显式的 0 写出去，旧版不会回到自己的默认字数');
  assert.equal('reviewMinChars' in toFlat({ profile: 2, modules: { review: {} } }), false, '没写的仍不写');
  assert.equal('reviewMinChars' in toFlat({ profile: 2 }), false, '没有 modules.review 段也不写');
  // 扁平 → profile：调用方按原始文件判断是否显式写了 0；回滚再升级一圈后 0 仍在
  const flat = toFlat(explicit);
  assert.equal(toProfile(normalizeConfig(flat), { keepZeroMinChars: flat.reviewMinChars === 0 }).modules.review.reviewMinChars, 0);
  assert.equal(toFlat(toProfile(normalizeConfig(flat), { keepZeroMinChars: true })).reviewMinChars, 0, '来回一圈不变');
  assert.equal(toProfile(normalizeConfig(flat)).modules.review.reviewMinChars, undefined, '不带标记时 0 仍视为默认，不写');
});

test('显式 null 不静默回退默认值：fullTests、ciOs 等默认非 null 的键写 null 报错；默认就是 null 的键写 null 等于不写', () => {
  assert.throws(() => normalizeConfig({ profile: 2, modules: { gate: { fullTests: null } } }), /modules\.gate\.fullTests 不能是 null/);
  assert.throws(() => normalizeConfig({ profile: 2, modules: { environment: { ciOs: null } } }), /modules\.environment\.ciOs 不能是 null/);
  assert.throws(() => normalizeConfig({ profile: 2, modules: { gate: { reviewFlow: null } } }), /reviewFlow 不能是 null/);
  assert.throws(() => normalizeConfig({ profile: 2, rules: { reviewIgnore: null } }), /rules\.reviewIgnore 不能是 null/);
  // 显式的非法值同样报错（不回退）
  assert.throws(() => normalizeConfig({ profile: 2, modules: { gate: { fullTests: 'cloud' } } }), /fullTests 只能是/);
  assert.throws(() => normalizeConfig({ profile: 2, modules: { environment: { ciOs: [] } } }), /ciOs 必须是/);
  // 旧版扁平结构里的 null 同样报错
  assert.throws(() => normalizeConfig({ base: 'main', fullTests: null }), /fullTests 不能是 null/);
  assert.throws(() => normalizeConfig({ base: 'main', ciOs: null }), /ciOs 不能是 null/);
  const eff = normalizeConfig({ profile: 2, modules: { gate: { ciRunner: null, ciFallback: null }, environment: { session: null, parallel: null } } });
  assert.equal(eff.ciRunner, null);
  assert.equal(eff.fullTests, DEFAULTS.fullTests);
  assert.deepEqual(eff.ciOs, DEFAULTS.ciOs);
});

test('类型校验（新旧结构共用）：写错类型的字段报错，不让对应检查静默失效', () => {
  for (const [raw, why] of [
    [{ profile: 2, modules: { review: { reviewMinChars: 'abc' } } }, /reviewMinChars 必须是非负整数/],
    [{ profile: 2, modules: { review: { reviewKeyword: '' } } }, /reviewKeyword 必须是非空字符串/],
    [{ profile: 2, modules: { review: { reviewers: 'x' } } }, /reviewers 必须是/],
    [{ profile: 2, modules: { gate: { lockMaxAgeMinutes: '90' } } }, /lockMaxAgeMinutes 必须是正数/],
    [{ profile: 2, modules: { gate: { testEnv: { A: 1 } } } }, /testEnv 必须是/],
    [{ profile: 2, modules: { gate: { base: 5 } } }, /base 必须是非空字符串/],
    [{ profile: 2, layout: { sourceGlobs: 'src/**' } }, /layout\.sourceGlobs 必须是/],
    [{ profile: 2, rules: { commentMode: 'all' } }, /commentMode 只能是/],
    [{ base: 'main', sourceGlobs: null }, /sourceGlobs 不能是 null/],
    [{ base: 'main', reviewMinChars: 'abc' }, /reviewMinChars 必须是非负整数/],
  ]) assert.throws(() => normalizeConfig(raw), why, JSON.stringify(raw));
  assert.doesNotThrow(() => normalizeConfig({ profile: 2 }));
  assert.doesNotThrow(() => normalizeConfig({}));
});
// ---------- C2 测试度量新增的四个配置键（规格 spec-CD 第 1 节） ----------

const gateCfg = (gate) => ({ profile: 2, modules: { gate } });

test('C2 缺省：testLayers [] / testReports [] / coverage null / mutationCommand null；旧配置没有这些键行为不变', () => {
  for (const k of ['testLayers', 'testReports', 'coverage', 'mutationCommand']) assert.ok(FLAT_KEYS.includes(k), `${k} 要在 FLAT_KEYS 里`);
  assert.deepEqual([DEFAULTS.testLayers, DEFAULTS.testReports, DEFAULTS.coverage, DEFAULTS.mutationCommand], [[], [], null, null]);
  const eff = normalizeConfig({ profile: 2 });
  assert.deepEqual([eff.testLayers, eff.testReports, eff.coverage, eff.mutationCommand], [[], [], null, null]);
  const flat = normalizeConfig({ base: 'main', sourceGlobs: ['src/**/*.py'] });
  assert.deepEqual([flat.testLayers, flat.testReports, flat.coverage, flat.mutationCommand], [[], [], null, null], '旧的扁平配置同样取缺省');
});

test('C2 合法取值原样展开（profile 的 modules.gate 与旧扁平结构两种写法）', () => {
  const gate = { testLayers: [{ name: 'unit', paths: ['tests/unit/**'] }, { name: 'e2e', paths: ['e2e/**', 'tests/e2e/**'] }], testReports: ['reports/*.xml', 'out/junit-*.xml'], coverage: { command: 'npm run cov', lcov: 'coverage/lcov.info' }, mutationCommand: 'npx stryker run' };
  for (const eff of [normalizeConfig(gateCfg(gate)), normalizeConfig({ base: 'main', ...gate })]) {
    assert.deepEqual(eff.testLayers, gate.testLayers);
    assert.deepEqual(eff.testReports, gate.testReports);
    assert.deepEqual(eff.coverage, gate.coverage);
    assert.equal(eff.mutationCommand, gate.mutationCommand);
  }
});

test('C2 不是判定策略字段：四个键不在 POLICY_KEYS 里（取工作区的值，不取基准提交上的）', () => {
  for (const k of ['testLayers', 'testReports', 'coverage', 'mutationCommand']) assert.ok(!POLICY_KEYS.includes(k), `${k} 不应是判定策略字段`);
});

test('C2 testLayers 校验：每项 { name, paths }；name 非空、无首尾空白、不重复；paths 非空 glob 字符串数组；报错写出键的完整路径和当前值', () => {
  const bads = [
    'unit',
    {},
    [null],
    ['unit'],
    [{ paths: ['a/**'] }],
    [{ name: '', paths: ['a/**'] }],
    [{ name: '  ', paths: ['a/**'] }],
    [{ name: ' unit', paths: ['a/**'] }],
    [{ name: 'unit ', paths: ['a/**'] }],
    [{ name: 5, paths: ['a/**'] }],
    [{ name: 'unit', paths: ['a/**'] }, { name: 'unit', paths: ['b/**'] }],
    [{ name: 'unit' }],
    [{ name: 'unit', paths: [] }],
    [{ name: 'unit', paths: 'a/**' }],
    [{ name: 'unit', paths: [''] }],
    [{ name: 'unit', paths: [3] }],
  ];
  for (const bad of bads) {
    assert.throws(() => normalizeConfig(gateCfg({ testLayers: bad })), (e) => /modules\.gate\.testLayers/.test(e.message) && e.message.includes(JSON.stringify(bad)), JSON.stringify(bad));
  }
  assert.doesNotThrow(() => normalizeConfig(gateCfg({ testLayers: [] })));
  assert.throws(() => normalizeConfig({ base: 'main', testLayers: 'x' }), /testLayers/, '旧扁平结构同样校验');
});

test('C2 testReports 校验：非空字符串数组；报错写出完整路径和当前值', () => {
  for (const bad of ['reports/*.xml', [''], ['ok', '  '], [1], [null], {}]) {
    assert.throws(() => normalizeConfig(gateCfg({ testReports: bad })), (e) => /modules\.gate\.testReports/.test(e.message) && e.message.includes(JSON.stringify(bad)), JSON.stringify(bad));
  }
  assert.doesNotThrow(() => normalizeConfig(gateCfg({ testReports: ['a/*.xml'] })));
});

test('C2 coverage 校验：null 或 { command, lcov }；command 非空字符串；lcov 是仓库相对路径（isRepoPath）', () => {
  const ok = { command: 'npm run cov', lcov: 'coverage/lcov.info' };
  assert.doesNotThrow(() => normalizeConfig(gateCfg({ coverage: ok })));
  assert.equal(normalizeConfig(gateCfg({ coverage: null })).coverage, null, '写 null 等于不写');
  const bads = [
    'npm run cov', [], 5,
    { lcov: 'coverage/lcov.info' },
    { command: '', lcov: 'coverage/lcov.info' },
    { command: 5, lcov: 'coverage/lcov.info' },
    { command: 'npm run cov' },
    { command: 'npm run cov', lcov: '' },
    { command: 'npm run cov', lcov: 'coverage\\lcov.info' },
    { command: 'npm run cov', lcov: '/abs/lcov.info' },
    { command: 'npm run cov', lcov: 'C:/abs/lcov.info' },
    { command: 'npm run cov', lcov: '../lcov.info' },
    { command: 'npm run cov', lcov: 'a/./lcov.info' },
    { command: 'npm run cov', lcov: 7 },
  ];
  for (const bad of bads) {
    assert.throws(() => normalizeConfig(gateCfg({ coverage: bad })), (e) => /modules\.gate\.coverage/.test(e.message) && e.message.includes(JSON.stringify(bad)), JSON.stringify(bad));
  }
});

test('C2 mutationCommand 校验：null 或非空字符串；报错写出完整路径和当前值', () => {
  assert.equal(normalizeConfig(gateCfg({ mutationCommand: null })).mutationCommand, null);
  assert.equal(normalizeConfig(gateCfg({ mutationCommand: 'npx stryker run' })).mutationCommand, 'npx stryker run');
  for (const bad of ['', '   ', 5, [], {}, true]) {
    assert.throws(() => normalizeConfig(gateCfg({ mutationCommand: bad })), (e) => /modules\.gate\.mutationCommand/.test(e.message) && e.message.includes(JSON.stringify(bad)), JSON.stringify(bad));
  }
});

test('C2 互转：profile ⇄ 扁平带上四个键，值不丢', () => {
  const values = { testLayers: [{ name: 'unit', paths: ['tests/unit/**'] }], testReports: ['reports/*.xml'], coverage: { command: 'npm run cov', lcov: 'coverage/lcov.info' }, mutationCommand: 'npx stryker run' };
  const prof = toProfile({ base: 'main', sourceGlobs: ['src/**/*.ts'], testGlobs: ['tests/**/*.ts'], ...values });
  for (const [k, v] of Object.entries(values)) assert.deepEqual(prof.modules.gate[k], v, `${k} 写进 profile 的 modules.gate`);
  const flat = toFlat(prof);
  for (const [k, v] of Object.entries(values)) assert.deepEqual(flat[k], v, `${k} 回滚到扁平结构后仍在`);
  const again = normalizeConfig(toProfile(flat));
  for (const [k, v] of Object.entries(values)) assert.deepEqual(again[k], v, `${k} 来回一圈不变`);
});

test('C2 模板：_说明 里写了四个键的用途，但模板的 modules.gate 里不写这四个键', () => {
  const raw = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
  const notes = [];
  const walk = (v) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === '_说明') notes.push(typeof x === 'string' ? x : JSON.stringify(x)); walk(x); } };
  walk(raw);
  const text = notes.join('\n');
  for (const k of ['testLayers', 'testReports', 'coverage', 'mutationCommand']) {
    assert.ok(text.includes(k), `_说明 要提到 ${k}`);
    assert.equal(Object.hasOwn(raw.modules.gate, k), false, `模板不写 ${k} 的值`);
  }
  assert.doesNotThrow(() => normalizeConfig(raw), '模板仍是合法配置');
});
