// 工程能力包测试：规则标记块、整包校验、原子同步（失败整体回滚）、整包漂移检查、文档模板与阶段目录、按标签回滚。
// 每个用例都在临时仓库里跑真实同步，失败注入只影响测试本身。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { syncKit, extractTag, BUNDLE_ROOT } from '../sync.mjs';
import { applyBlock, findBlock, checkBundle, validateBundle, loadBundle, LOCK_REL } from '../tools/bundle-lib.mjs';

/** 当前整包版本从清单读取（不写死），发布新版本时测试不需要跟着改。 */
const CURRENT = loadBundle(BUNDLE_ROOT).bundleVersion;
import { commitAll, git, read, tmpRepo, write, tmpDir, trackTmp } from './helpers.mjs';

/** 一个带用户内容的 AGENTS.md（块外内容必须原样保留）。 */
const USER_AGENTS = '# 项目指导\n\n这是项目自己的规则，不能被同步改动。\n';

/** 目标项目：已有 AGENTS.md 与一次提交。 */
function targetRepo() {
  const root = tmpRepo();
  write(root, 'AGENTS.md', USER_AGENTS);
  write(root, 'README.md', '# 项目\n');
  commitAll(root, 'base');
  return root;
}

/** 复制整包到临时目录，并把 bundleVersion 改为 version（模拟新版本）。 */
function bundleCopy(version) {
  const dir = tmpDir('ekit-bundle-');
  fs.cpSync(BUNDLE_ROOT, dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}tests`) });
  const bj = path.join(dir, 'bundle.json');
  const j = JSON.parse(fs.readFileSync(bj, 'utf8'));
  j.bundleVersion = version;
  fs.writeFileSync(bj, JSON.stringify(j, null, 2));
  return dir;
}

test('标记块：没有块时追加到末尾，块外内容不动', () => {
  const out = applyBlock('# 我的规则\n\n内容\n', '0.2.0', '规则正文');
  assert.ok(out.startsWith('# 我的规则\n\n内容\n\n<!-- engineering-kit:begin v0.2.0 -->'));
  assert.ok(out.includes('规则正文'));
  assert.ok(out.trimEnd().endsWith('<!-- engineering-kit:end -->'));
});

test('标记块：只替换块内内容，块前后的项目内容逐字保留，重复应用结果不变', () => {
  const first = applyBlock('前言\n', '0.2.0', '旧正文');
  const text = `${first}\n项目后记\n`;
  const next = applyBlock(text, '0.3.0', '新正文');
  assert.ok(next.startsWith('前言\n'));
  assert.ok(next.endsWith('\n项目后记\n'));
  assert.ok(next.includes('<!-- engineering-kit:begin v0.3.0 -->\n新正文\n'));
  assert.equal(applyBlock(next, '0.3.0', '新正文'), next, '重复应用应当幂等');
});

test('标记块：标记不成对或重复时拒绝改写', () => {
  assert.throws(() => findBlock('<!-- engineering-kit:begin v0.2.0 -->\n只有开始\n'), /不平衡/);
  assert.throws(() => applyBlock('<!-- engineering-kit:begin v1.0.0 -->\na\n<!-- engineering-kit:end -->\n<!-- engineering-kit:begin v1.0.0 -->\nb\n<!-- engineering-kit:end -->\n', '1.0.0', 'x'), /不平衡/);
  assert.throws(() => applyBlock('', '0.2.0', '含有 <!-- engineering-kit:end --> 的正文'), /标记行/);
});

test('清单校验：版本号非法、组件缺源、JSON 源不合法，都在写入前报错', () => {
  const dir = tmpDir('ekit-val-');
  fs.mkdirSync(path.join(dir, 'kit'));
  fs.writeFileSync(path.join(dir, 'kit', 'bad.json'), '{ 不是 json');
  const base = { name: 'x', bundleVersion: '1.0.0', configFormat: 'profile' };
  assert.throws(() => validateBundle({ ...base, bundleVersion: 'v1' , components: [{ id: 'a', kind: 'project-file', owner: 'project', source: 'kit/bad.json', target: 'a.json' }] }, dir), /bundleVersion/);
  assert.throws(() => validateBundle({ ...base, components: [{ id: 'a', kind: 'gate', owner: 'kit', source: 'kit/none.mjs', target: 'a.mjs' }] }, dir), /源文件不存在/);
  assert.throws(() => validateBundle({ ...base, components: [{ id: 'c', kind: 'config', owner: 'project', source: 'kit/bad.json', target: 'engineering.config.json' }] }, dir), /源 JSON 不合法/);
  assert.throws(() => validateBundle({ ...base, components: [{ id: 'a', kind: 'gate', owner: 'kit', source: 'kit', target: '../escape' }] }, dir), /target/);
});

test('整包同步：规则进入 AGENTS.md 的标记块，项目原有内容保留，并写入锁文件', () => {
  const root = targetRepo();
  const r = syncKit({ target: root });
  assert.equal(r.ok, true, r.messages.join('\n'));
  const agents = read(root, 'AGENTS.md');
  assert.ok(agents.startsWith(USER_AGENTS), '块外的项目内容必须原样保留');
  assert.ok(findBlock(agents), '应当写入标记块');
  const lock = JSON.parse(read(root, LOCK_REL));
  assert.equal(lock.bundleVersion, CURRENT);
  assert.equal(lock.blocks['AGENTS.md'], CURRENT);
});

test('整包更新：新版本只替换标记块，块外内容仍然不变', () => {
  const root = targetRepo();
  syncKit({ target: root });
  const upgraded = bundleCopy('0.3.0');
  const r = syncKit({ target: root, bundleRoot: upgraded });
  assert.equal(r.ok, true);
  const agents = read(root, 'AGENTS.md');
  assert.ok(agents.startsWith(USER_AGENTS));
  assert.equal(findBlock(agents).version, '0.3.0');
  assert.equal(JSON.parse(read(root, LOCK_REL)).bundleVersion, '0.3.0');
});

test('原子同步：冒烟失败时整体回滚，项目文件与事前完全一致', () => {
  const root = targetRepo();
  const before = read(root, 'AGENTS.md');
  assert.throws(() => syncKit({ target: root, inject: 'smoke' }), /冒烟测试未通过/);
  assert.equal(read(root, 'AGENTS.md'), before, 'AGENTS.md 必须恢复原样');
  assert.equal(fs.existsSync(path.join(root, 'scripts', 'engineering')), false, '新建的目录必须删除');
  assert.equal(fs.existsSync(path.join(root, 'engineering.config.json')), false);
  assert.equal(fs.existsSync(path.join(root, LOCK_REL)), false);
});

test('原子同步：写入中途失败、或写锁失败，同样整体回滚', () => {
  const root = targetRepo();
  const before = read(root, 'AGENTS.md');
  assert.throws(() => syncKit({ target: root, inject: 'write' }), /注入的写入失败/);
  assert.equal(read(root, 'AGENTS.md'), before);
  assert.equal(fs.existsSync(path.join(root, 'scripts', 'engineering')), false);
  assert.throws(() => syncKit({ target: root, inject: 'lock' }), /注入的锁文件写入失败/);
  assert.equal(read(root, 'AGENTS.md'), before);
  assert.equal(fs.existsSync(path.join(root, LOCK_REL)), false);
});

test('整包漂移检查：同步后全部一致；改动标记块或删除文件后逐项报出', () => {
  const root = targetRepo();
  syncKit({ target: root });
  assert.equal(checkBundle({ root, bundleRoot: BUNDLE_ROOT }).ok, true);
  const agents = read(root, 'AGENTS.md').replace('1. 开工：', '1. 开工（被改动）：');
  write(root, 'AGENTS.md', agents);
  fs.rmSync(path.join(root, 'docs', 'README.md'));
  const rep = checkBundle({ root, bundleRoot: BUNDLE_ROOT });
  assert.equal(rep.ok, false);
  assert.ok(rep.items.some((i) => i.file === 'AGENTS.md' && i.state === 'modified'), JSON.stringify(rep.items.filter((i) => i.file === 'AGENTS.md')));
  assert.ok(rep.items.some((i) => i.file === 'docs/README.md' && i.state === 'missing'));
});

test('文档：阶段目录与索引、模板随整包安装；模板不会被当作阶段', () => {
  const root = targetRepo();
  syncKit({ target: root });
  for (const stage of ['00-总览', '01-需求', '02-原型', '03-架构', '04-开发', '05-测试', '06-发布']) {
    assert.ok(fs.existsSync(path.join(root, 'docs', stage, 'README.md')), `缺少阶段 ${stage}`);
  }
  assert.ok(fs.existsSync(path.join(root, 'docs', 'README.md')));
  assert.ok(fs.existsSync(path.join(root, 'docs', '_templates', 'adr.md')));
  assert.ok(fs.existsSync(path.join(root, 'docs', '_templates', 'feature-contract.md')));
});

test('功能契约模板：提示写明日期、时间字段的时区口径', () => {
  const root = targetRepo();
  syncKit({ target: root });
  const contract = read(root, 'docs/_templates/feature-contract.md');
  assert.match(contract, /时区/);
  for (const word of ['存储', '展示', '边界']) assert.ok(contract.includes(word), `时区提示缺“${word}”`);
});

test('功能契约模板：“预期行为与异常边界”一节排在验收标准之前，场景表三栏，五类情形逐类列出', () => {
  const root = targetRepo();
  syncKit({ target: root });
  const contract = read(root, 'docs/_templates/feature-contract.md');
  const at = contract.indexOf('## 预期行为与异常边界');
  assert.ok(at > 0 && at < contract.indexOf('## 怎样证明正确'), '场景表一节应在“怎样证明正确”之前');
  assert.match(contract, /\| 场景 \| 触发 \| 预期结果 \|/);
  for (const kind of ['正常', '失败', '超时', '并发或重复', '边界值']) assert.ok(contract.includes(`：${kind} |`), `场景表缺“${kind}”一类`);
  assert.ok(contract.includes('不适用') && contract.includes('不从实现倒推'));
});

test('按标签回滚：旧版本（0.1.0，扁平配置、无标记块）能装回，配置格式随之回退', () => {
  const tagExists = spawnSync('git', ['-C', BUNDLE_ROOT, 'rev-parse', '--verify', '--quiet', 'engineering-kit-v0.1.0^{commit}'], { encoding: 'utf8' }).status === 0;
  if (!tagExists) return; // 源仓库没有 0.1.0 标签时跳过（例如在别的克隆里运行）
  const root = targetRepo();
  syncKit({ target: root });
  assert.equal(JSON.parse(read(root, 'engineering.config.json')).profile, 2);
  const old = trackTmp(extractTag('engineering-kit-v0.1.0'));
  const r = syncKit({ target: root, bundleRoot: old });
  assert.equal(r.ok, true, r.messages.join('\n'));
  const cfg = JSON.parse(read(root, 'engineering.config.json'));
  assert.equal(cfg.profile, undefined, '回滚到 0.1.0 时配置应回到扁平结构');
  assert.equal(JSON.parse(read(root, LOCK_REL)).bundleVersion, '0.1.0');
  // 再升级回当前版本
  syncKit({ target: root });
  assert.equal(JSON.parse(read(root, LOCK_REL)).bundleVersion, CURRENT);
});

test('换行风格：CRLF 文件里插入的标记块也用 CRLF，不混入 LF；重复应用仍然幂等', () => {
  const crlf = '# 项目\r\n\r\n规则\r\n';
  const once = applyBlock(crlf, '0.2.0', '第一行\n第二行');
  assert.ok(!/[^\r]\n/.test(once), '不应出现单独的 LF');
  assert.ok(once.startsWith(crlf), '原文一字不动');
  assert.equal(applyBlock(once, '0.2.0', '第一行\n第二行'), once);
  assert.equal(findBlock(once).body, '第一行\n第二行');
});

test('清单外的旧套件文件有本地修改时：提示冲突并说明原因（不是空消息）', () => {
  const root = targetRepo();
  syncKit({ target: root });
  write(root, 'scripts/engineering/gone.mjs', '本地改过\n');
  const lock = JSON.parse(read(root, LOCK_REL));
  lock.files['scripts/engineering/gone.mjs'] = 'deadbeef';
  write(root, LOCK_REL, JSON.stringify(lock));
  const r = syncKit({ target: root });
  assert.ok(r.messages.some((m) => m.includes('gone.mjs') && m.includes('已不在新清单')), r.messages.join('\n'));
});

test('--from-tag：用完删除导出的临时目录', () => {
  const root = targetRepo();
  const tmp = tmpDir('ekit-tmpdir-');
  const r = spawnSync(process.execPath, [path.join(BUNDLE_ROOT, 'kit', 'sync.mjs'), '--target', root, '--check', '--from-tag', 'engineering-kit-v0.2.0'], {
    encoding: 'utf8',
    env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp },
  });
  assert.ok(r.stdout.includes('整包'), `未执行：${r.stdout}${r.stderr}`);
  assert.deepEqual(fs.readdirSync(tmp), [], '临时目录应已清理');
});

test('仓库根的 .gitattributes 与模板一致（同步按字节复制，CRLF 检出会弄坏脚本与哈希）', () => {
  const top = spawnSync('git', ['-C', BUNDLE_ROOT, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
  assert.equal(read(top, '.gitattributes').trim(), read(BUNDLE_ROOT, 'kit/templates/gitattributes').trim());
});

test('历史目录移动：独立仓库仍可导出旧 engineering-kit 标签的真实内容', () => {
  const exported = extractTag('engineering-kit-v0.2.0');
  try { assert.equal(read(exported, 'kit/VERSION').trim(), '0.2.0'); }
  finally { fs.rmSync(exported, { recursive: true, force: true }); }
});

/** 只看换行风格的工作区：core.autocrlf=true、项目自己的 .gitattributes 只写 text=auto（没有 eol=lf），装好套件并提交，再重新检出一遍。 */
function crlfCheckout() {
  const root = tmpRepo();
  git(root, ['config', 'core.autocrlf', 'true']);
  write(root, '.gitattributes', '* text=auto\n');
  write(root, 'README.md', '# 项目\n');
  commitAll(root, 'base');
  const first = syncKit({ target: root });
  assert.equal(first.ok, true, first.messages.join('\n'));
  commitAll(root, '安装套件');
  // 模拟重新克隆 / 切换分支后的检出：git 按 autocrlf 把文本文件写成 CRLF
  git(root, ['rm', '-rq', '--cached', '.']);
  git(root, ['reset', '-q', '--hard']);
  return root;
}

test('换行（autocrlf）：重新检出后套件文件是 CRLF，再同步不报本地修改冲突，漂移检查一致，工作区不出现只差换行的改动', () => {
  const root = crlfCheckout();
  assert.ok(read(root, 'scripts/engineering/gate/lib.mjs').includes('\r\n'), '前提：检出后套件文件是 CRLF');
  const again = syncKit({ target: root });
  assert.equal(again.ok, true, again.messages.join('\n'));
  assert.deepEqual(again.conflicts, []);
  const bad = checkBundle({ root, bundleRoot: BUNDLE_ROOT }).items.filter((i) => i.state !== 'ok');
  assert.deepEqual(bad, [], JSON.stringify(bad));
  assert.equal(git(root, ['status', '--porcelain']).trim(), '', '同步后工作区应没有改动');
});

test('换行（autocrlf）：升级时只有换行不同的套件文件照常更新；真有本地修改的仍报冲突', () => {
  const root = crlfCheckout();
  const upgraded = bundleCopy('0.9.0');
  const verifyFile = path.join(upgraded, 'kit', 'gate', 'verify.mjs');
  fs.writeFileSync(verifyFile, `${fs.readFileSync(verifyFile, 'utf8')}// 新版本追加的一行\n`);
  const r = syncKit({ target: root, bundleRoot: upgraded });
  assert.equal(r.ok, true, r.messages.join('\n'));
  assert.deepEqual(r.conflicts, []);
  assert.match(read(root, 'scripts/engineering/gate/verify.mjs'), /新版本追加的一行/);
  // 对照：真的改了内容（不只是换行）的套件文件仍报冲突
  const root2 = crlfCheckout();
  const f = path.join(root2, 'scripts', 'engineering', 'gate', 'verify.mjs');
  fs.writeFileSync(f, `${fs.readFileSync(f, 'utf8')}// 本地改动\r\n`);
  const r2 = syncKit({ target: root2, bundleRoot: upgraded });
  assert.equal(r2.ok, false);
  assert.ok(r2.conflicts.includes('scripts/engineering/gate/verify.mjs'), JSON.stringify(r2.conflicts));
});
