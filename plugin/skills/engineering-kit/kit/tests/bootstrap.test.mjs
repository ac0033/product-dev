// 从零开始的配置测试：空仓库（尚无提交）、尚无远程、尚无源码时，套件也要能给出完整可用的规则与结构。
// 业务含义：用户的目标是“一开始就配好必要的规则和结构”，而不是项目做到中途再改。这里覆盖：
//   基准分支自动识别（含首次提交前的空基线）、测试目录与白名单一致、技术栈预设与脚手架、
//   非 git 目录的显式初始化，以及尚无代码时闸门不空跑测试命令。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { git, tmpRepo, write, read, tmpDir, trackTmp } from './helpers.mjs';
import { resolveBase, changedFiles, EMPTY_TREE } from '../gate/lib.mjs';
import { runGate } from '../gate/gate.mjs';
import { runHygiene } from '../gate/hygiene.mjs';
import { LAYOUT_DEFAULTS, DEFAULTS } from '../gate/config.mjs';
import { PRESETS, applyPreset, scaffoldFiles } from '../tools/presets.mjs';
import { syncKit, BUNDLE_ROOT } from '../sync.mjs';
import { checkBundle } from '../tools/bundle-lib.mjs';

/** 一份最小的 profile 配置（与模板同结构），用于在测试仓库里直接指定布局。 */
function profileConfig(overrides = {}) {
  return {
    profile: 2,
    modules: { gate: { base: 'auto', testCommand: 'node -e "process.exit(0)"', testEnv: {} }, review: {} },
    layout: { sourceGlobs: ['src/**/*.ts'], testGlobs: ['test/**/*.test.ts'], ...overrides.layout },
    hygiene: {},
    rules: { reviewIgnore: ['**/*.md', 'docs/**'] },
  };
}

test('基准分支 auto：没有任何提交时使用空基线，首次提交前的所有文件都算改动', () => {
  const root = tmpRepo();
  write(root, 'src/demo/a.ts', '// 示例模块：首次提交前的文件也要被闸门看到。\nexport const a = 1;\n');
  assert.equal(resolveBase(root, 'auto'), EMPTY_TREE);
  assert.ok(changedFiles(root, 'auto').includes('src/demo/a.ts'));
});

test('基准分支 auto：有 main 时取 main', () => {
  const root = tmpRepo();
  write(root, 'README.md', 'x\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'init']);
  assert.equal(resolveBase(root, 'auto'), 'main');
});

test('基准分支 auto：有提交但找不到任何主干分支时报错，不静默放行', () => {
  const root = tmpRepo();
  write(root, 'README.md', 'x\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'init']);
  git(root, ['branch', '-m', 'main', 'dev']);
  assert.throws(() => resolveBase(root, 'auto'), /无法自动识别基准分支/);
});

test('基准分支写明但解析不了：仍然报错（失败不放行）', () => {
  const root = tmpRepo();
  write(root, 'README.md', 'x\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'init']);
  assert.throws(() => changedFiles(root, 'origin/main'), /无法解析基准分支 origin\/main/);
});

test('白名单：测试目录与源码目录由 layout 的 glob 推出，不需要另外登记', () => {
  const root = tmpRepo();
  write(root, 'engineering.config.json', JSON.stringify(profileConfig({ layout: { sourceGlobs: ['src/**/*.ts'], testGlobs: ['test/**/*.test.ts'] } })));
  write(root, 'test/a.test.ts', 'x\n');
  write(root, 'src/a.ts', 'x\n');
  const { findings } = runHygiene(root);
  assert.equal(findings.error.filter((m) => m.includes('顶层目录不在白名单')).length, 0, findings.error.join('\n'));
});

test('白名单：默认包含 .claude（钩子安装后必然存在）', () => {
  assert.ok(LAYOUT_DEFAULTS.topLevelAllowed.includes('.claude'));
});

test('默认基准分支是 auto，不再写死 origin/main', () => {
  assert.equal(DEFAULTS.base, 'auto');
});

test('闸门：尚无源码与测试文件时不运行测试命令', () => {
  const root = tmpRepo();
  // 测试命令故意写成必定失败：若被运行，结果会是未通过
  const cfg = profileConfig({ layout: {} });
  cfg.modules.gate.testCommand = 'node -e "process.exit(9)"';
  write(root, 'engineering.config.json', JSON.stringify(cfg));
  write(root, 'package.json', '{}\n');
  const res = runGate({ root });
  assert.equal(res.ok, true, res.messages.join('\n'));
  assert.ok(res.messages.some((m) => m.includes('未运行测试命令')), res.messages.join('\n'));
});

test('闸门：一旦出现源码，即使没有测试也拦截（测试先行），不因跳过逻辑被绕过', () => {
  const root = tmpRepo();
  write(root, 'engineering.config.json', JSON.stringify(profileConfig()));
  write(root, 'src/a.ts', '// 示例模块：没有测试引用的源码必须被拦截。\nexport const a = 1;\n');
  const res = runGate({ root });
  assert.equal(res.ok, false);
  assert.ok(res.messages.some((m) => m.includes('没有引用它的测试')), res.messages.join('\n'));
});

test('预设：ts 与 python 都给出完整字段，测试目录是字面路径（能推出白名单）', () => {
  for (const name of ['ts', 'python']) {
    const p = PRESETS[name];
    assert.ok(p, name);
    assert.equal(p.gate.base, 'auto');
    assert.ok(p.gate.testCommand.length > 0);
    assert.ok(p.layout.sourceGlobs.length > 0 && p.layout.testGlobs.length > 0);
    const dir = p.layout.testGlobs[0].split('/')[0];
    assert.ok(!/[*?{[]/.test(dir), `${name} 的测试目录必须是字面路径：${dir}`);
    assert.ok(Object.keys(scaffoldFiles(p, 'demo')).length > 0);
  }
});

test('预设：应用到模板后只改技术栈相关字段，其余保持模板原样', () => {
  const tpl = profileConfig();
  const out = applyPreset(tpl, PRESETS.python);
  assert.equal(out.modules.gate.testCommand, PRESETS.python.gate.testCommand);
  assert.deepEqual(out.layout.sourceGlobs, PRESETS.python.layout.sourceGlobs);
  assert.deepEqual(out.modules.review, tpl.modules.review);
  assert.deepEqual(tpl.layout.sourceGlobs, ['src/**/*.ts'], '不改动传入的模板');
});

test('--init：非 git 目录不加 --init 时拒绝安装且不写任何文件', () => {
  const dir = tmpDir('ekit-plain-');
  const r = syncKit({ target: dir });
  assert.equal(r.ok, false);
  assert.ok(r.messages.some((m) => m.includes('--init')), r.messages.join('\n'));
  assert.equal(fs.existsSync(path.join(dir, 'AGENTS.md')), false);
  assert.equal(fs.existsSync(path.join(dir, 'engineering.config.json')), false);
});

test('--init：加上后自动 git init（分支 main），并完成安装', () => {
  const dir = tmpDir('ekit-init-');
  const r = syncKit({ target: dir, init: true, preset: PRESETS.ts });
  assert.equal(r.ok, true, r.messages.join('\n'));
  assert.ok(fs.existsSync(path.join(dir, '.git')));
  assert.equal(git(dir, ['symbolic-ref', '--short', 'HEAD']).trim(), 'main');
});

test('--profile python：首次安装写入技术栈配置与脚手架，安装后整包检查一致', () => {
  const dir = tmpDir('ekit-py-');
  const r = syncKit({ target: dir, init: true, preset: PRESETS.python });
  assert.equal(r.ok, true, r.messages.join('\n'));
  const cfg = JSON.parse(read(dir, 'engineering.config.json'));
  assert.equal(cfg.modules.gate.testCommand, PRESETS.python.gate.testCommand);
  assert.deepEqual(cfg.layout.sourceGlobs, ['src/**/*.py']);
  assert.ok(fs.existsSync(path.join(dir, 'pyproject.toml')));
  assert.ok(read(dir, 'pyproject.toml').includes('pythonpath = ["src"]'));
  assert.ok(fs.existsSync(path.join(dir, '.gitignore')));
  const check = checkBundle({ root: dir, bundleRoot: BUNDLE_ROOT });
  const bad = check.items.filter((i) => i.state !== 'ok');
  assert.deepEqual(bad, [], JSON.stringify(bad));
});

test('--profile：配置已存在时不改写配置，并提示技术栈需手动修改', () => {
  const dir = tmpDir('ekit-keep-');
  syncKit({ target: dir, init: true, preset: PRESETS.ts });
  const before = read(dir, 'engineering.config.json');
  const r = syncKit({ target: dir, preset: PRESETS.python });
  assert.equal(read(dir, 'engineering.config.json'), before);
  assert.ok(r.messages.some((m) => m.includes('--profile 只在首次创建时生效')), r.messages.join('\n'));
});

test('ts 脚手架：package.json 的 test 脚本可直接运行 .test.ts（Node 内置测试运行器）', () => {
  const pkg = JSON.parse(scaffoldFiles(PRESETS.ts, 'demo')['package.json']);
  assert.equal(pkg.scripts.test, 'node --test');
  assert.equal(pkg.type, 'module');
});

test('树哈希：同一份提交内容在 CRLF 与 LF 的工作区下哈希相同（Windows 的 autocrlf 会改写换行）', async () => {
  const { treeHash } = await import('../gate/lib.mjs');
  const root = tmpRepo();
  git(root, ['config', 'core.autocrlf', 'true']);
  write(root, 'src/a.ts', '// 示例：换行符的哈希稳定性。\nexport const a = 1;\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'init']);
  const lf = treeHash(root, ['src/a.ts']);
  // 模拟 checkout 之后工作区变成 CRLF：内容未变，只换行符不同
  fs.writeFileSync(path.join(root, 'src/a.ts'), '// 示例：换行符的哈希稳定性。\r\nexport const a = 1;\r\n');
  assert.equal(treeHash(root, ['src/a.ts']), lf);
});

test('命令行入口：经由目录连接（junction/符号链接）调用时也要执行，不能静默什么都不做', () => {
  // Windows 上安装目录可能是指向另一个目录的连接，Node 会把模块路径解析为真实路径；
  // 若入口判断只比较字符串，就会出现“退出码 0、什么输出也没有”。
  const real = tmpDir('ekit-real-');
  const link = trackTmp(`${real}-link`); // 登记在 real 之后，清理时先删
  fs.symlinkSync(real, link, 'junction');
  const kit = path.resolve(BUNDLE_ROOT, 'kit');
  fs.cpSync(kit, path.join(real, 'kit'), { recursive: true });
  const dir = tmpDir('ekit-target-');
  git(dir, ['init', '-q', '-b', 'main']);
  const r = spawnSync(process.execPath, [path.join(link, 'kit', 'sync.mjs'), '--target', dir, '--check'], { encoding: 'utf8' });
  assert.ok(r.stdout.includes('整包'), `入口未执行：stdout=${r.stdout} stderr=${r.stderr}`);
});
