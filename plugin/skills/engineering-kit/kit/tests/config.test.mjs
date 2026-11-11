// 配置 profile 测试：engineering.config.json 的四段结构（modules、layout、hygiene、rules）与旧的扁平结构互转。
// 业务含义：项目配置是唯一由项目维护的文件，结构要稳定、可升级；旧版扁平配置必须仍能读取（回滚与迁移都依赖它）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS, normalizeConfig, toFlat, toProfile, FLAT_KEYS } from '../gate/config.mjs';
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
    reviewMinChars: 200, reviewKeyword: '结论', lockMaxAgeMinutes: 90, reviewFlow: 'pr',
  };
  const prof = toProfile(flat);
  assert.equal(prof.profile, 2);
  assert.deepEqual(Object.keys(prof.modules).sort(), ['gate', 'review']);
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
