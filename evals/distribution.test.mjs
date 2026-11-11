// 独立仓库的分发契约：身份、元数据、许可和安装文档指向同一个发行版。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const json = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const claude = json('plugin/.claude-plugin/plugin.json');
const codex = json('plugin/.codex-plugin/plugin.json');
const npm = json('dsh/package.json');
test('三个分发保持既有身份和统一版本，元数据指向独立仓库', () => {
  assert.equal(claude.name, 'product-dev');
  assert.equal(codex.name, claude.name);
  assert.equal(npm.name, 'dsh-product-dev');
  assert.equal(codex.version, claude.version);
  assert.equal(npm.version, claude.version);
  for (const manifest of [claude, codex, npm]) assert.equal(manifest.homepage, 'https://github.com/ac0033/product-dev');
  for (const manifest of [claude, codex]) assert.equal(manifest.repository, 'https://github.com/ac0033/product-dev');
  assert.deepEqual(npm.repository, { type: 'git', url: 'git+https://github.com/ac0033/product-dev.git', directory: 'dsh' });
  assert.equal(npm.bugs.url, 'https://github.com/ac0033/product-dev/issues');
});
test('Codex 继续只注册原入口，插件许可证来自仓库根', () => {
  assert.equal(codex.skills, './skills/product-dev/');
  assert.ok(fs.existsSync(path.join(ROOT, 'plugin', codex.skills, 'SKILL.md')));
  assert.deepEqual(fs.readFileSync(path.join(ROOT, 'LICENSE')), fs.readFileSync(path.join(ROOT, 'plugin/LICENSE')));
});
test('使用文档链接存在，便携包版本与本次发行一致', () => {
  for (const doc of ['README.md', 'INSTALL.md', 'COMPONENTS.md']) {
    const text = fs.readFileSync(path.join(ROOT, doc), 'utf8');
    for (const m of text.replace(/```[\s\S]*?```/g, '').matchAll(/\]\(([^)\s]+)\)/g)) {
      const file = decodeURIComponent(m[1]).split('#')[0];
      if (/^[a-z][a-z0-9+.-]*:/.test(file) || !file) continue;
      assert.ok(fs.existsSync(path.resolve(ROOT, path.dirname(doc), file)), doc + ' → ' + m[1]);
    }
  }
  const install = fs.readFileSync(path.join(ROOT, 'INSTALL.md'), 'utf8');
  assert.ok(install.includes('https://github.com/ac0033/product-dev/releases/download/v' + claude.version + '/product-dev-skill.zip'));
});

test('入口所写的套件源码位置与独立仓库实际目录一致', () => {
  const entry = fs.readFileSync(path.join(ROOT, 'plugin/skills/product-dev/SKILL.md'), 'utf8');
  assert.ok(entry.includes('components/engineering-kit/kit'), '入口没有说明独立仓库的套件源码位置');
  assert.ok(fs.existsSync(path.join(ROOT, 'components/engineering-kit/kit/sync.mjs')));
});
