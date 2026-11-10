// 插件市场清单检查：Claude Code 与 Codex 两份市场清单都要列出综合插件，版本与插件清单一致，路径指向真实目录。
// 业务含义：用户靠市场清单安装插件；清单与插件版本不一致时，装到的不是所说的版本。
// 运行：在仓库根目录 node --test evals/marketplace.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const pluginVersion = json('product-dev/.claude-plugin/plugin.json').version;

test('两份插件清单的版本一致', () => {
  assert.equal(json('product-dev/.codex-plugin/plugin.json').version, pluginVersion);
});

test('Claude Code 市场清单：列出 product-dev，版本一致，路径存在', () => {
  const entry = json('.claude-plugin/marketplace.json').plugins.find((p) => p.name === 'product-dev');
  assert.ok(entry, '市场清单里没有 product-dev');
  assert.equal(entry.version, pluginVersion);
  assert.ok(fs.existsSync(path.join(ROOT, entry.source, '.claude-plugin', 'plugin.json')), `路径不存在：${entry.source}`);
});

test('Codex 市场清单：列出 product-dev，版本一致，路径存在', () => {
  const entry = json('.agents/plugins/marketplace.json').plugins.find((p) => p.name === 'product-dev');
  assert.ok(entry, '市场清单里没有 product-dev');
  assert.equal(entry.version, pluginVersion);
  assert.ok(fs.existsSync(path.join(ROOT, entry.source.path, '.codex-plugin', 'plugin.json')), `路径不存在：${entry.source.path}`);
});
