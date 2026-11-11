// DeepSeek Harness（DSH）npm 包的检查：清单满足 DSH“添加插件”的要求，装配出的包能向 DSH 提供入口技能。
// 业务含义：DSH 安装前会检查包是否声明了 bundle 补丁和兼容的 DSH 版本，不合格直接拒绝；
// 技能目录只认一层 <名称>/SKILL.md，名称须是小写短横线，描述超过 500 字符会被截断。
// 运行：在仓库根目录 node --test evals/dsh-package.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildDshPackage } from '../tools/build-dsh-package.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const manifest = json(path.join(ROOT, 'dsh/package.json'));
const pluginVersion = json(path.join(ROOT, 'plugin/.claude-plugin/plugin.json')).version;

test('清单：声明 bundle 补丁和 DSH 版本范围，版本与插件一致，补丁行加载的就是本包', () => {
  assert.equal(manifest.version, pluginVersion);
  assert.match(manifest.name, /^[a-z0-9][a-z0-9._~-]*$/, '包名须是 DSH 添加插件框接受的 npm 包名');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(manifest.engines.dsh.trim(), '没有声明 engines.dsh 时，插件市场索引不收录');
  assert.ok(manifest.keywords.includes('dsh-plugin'));
  const patch = fs.readFileSync(path.join(ROOT, 'dsh/cordis.patch.yml'), 'utf8');
  assert.match(patch, new RegExp(`^\\s+name: '${manifest.name}'$`, 'm'), '补丁行的 name 须等于包名');
  for (const doc of ['dsh/README.md', 'README.md', 'INSTALL.md']) {
    assert.ok(fs.readFileSync(path.join(ROOT, doc), 'utf8').includes(`${manifest.name}@${manifest.version}`), `${doc} 里的安装规格不是 ${manifest.name}@${manifest.version}`);
  }
});

test('装配出的包：files 列出的内容齐全，只提供 product-dev 一个技能，正文和资源目录可用', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'product-dev-dsh-'));
  try {
    const out = buildDshPackage(path.join(scratch, 'package'));
    for (const entry of manifest.files) assert.ok(fs.existsSync(path.join(out, entry)), `包里缺少 ${entry}`);
    assert.ok(fs.existsSync(path.join(out, manifest.main)));
    assert.throws(() => buildDshPackage(out), { code: 'EEXIST' });

    const plugin = await import(pathToFileURL(path.join(out, manifest.main)).href);
    assert.deepEqual(plugin.inject, ['skills']);
    // 模拟 DSH 的技能注册服务：apply 时同步登记一个来源工厂
    let provider;
    plugin.apply({ skills: { registerProvider: (create) => { provider = create({ signal: new AbortController().signal, invalidate() {} }); return () => {}; } } });

    const listed = await provider.list({});
    assert.deepEqual(listed.map((c) => c.name), ['product-dev']);
    const [candidate] = listed;
    assert.match(candidate.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok([...candidate.description].length <= 500, '描述超过 DSH 技能目录的 500 字符上限');
    assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true });
    assert.equal(candidate.resourceBase.kind, 'directory');

    const loaded = await provider.get(candidate, {});
    assert.equal(loaded.name, 'product-dev');
    assert.ok(!loaded.content.startsWith('---'), '正文不应带文件头');
    assert.ok(!('rank' in loaded) && !('locator' in loaded));
    // 入口正文指向的完整工作流，在资源目录下确实存在
    const workflow = loaded.content.match(/\]\((references\/[^)]+WORKFLOW\.md)\)/)?.[1];
    assert.ok(workflow && fs.existsSync(path.join(loaded.resourceBase.path, workflow)), '入口指向的完整工作流不存在');
    assert.equal(await provider.get({ ...candidate, name: 'missing' }, {}), undefined);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
