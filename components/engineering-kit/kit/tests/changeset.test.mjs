// 变更集与发布测试：提案登记与排序、用户经验直接应用、agent 经验须确认、失败整体恢复、标签发布。
// 每个用例都在临时副本里操作，不改动真正的整包源码。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { applyChangeset, listPending, proposeChangeset, validateChangeset } from '../tools/changeset.mjs';
import { releaseBundle } from '../tools/release.mjs';
import { git, tmpRepo, write, read, commitAll, tmpDir } from './helpers.mjs';
import { BUNDLE_ROOT } from '../sync.mjs';
import { loadBundle } from '../tools/bundle-lib.mjs';

/** 当前整包版本从清单读取（不写死），发布新版本时测试不需要跟着改。 */
const CURRENT = loadBundle(BUNDLE_ROOT).bundleVersion;

/** 临时副本的整包（去掉 changesets 与 .git），返回路径。 */
function bundleCopy() {
  const dir = tmpDir('ekit-cs-');
  fs.cpSync(BUNDLE_ROOT, dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}changesets`) && !src.includes(`${path.sep}.git`) });
  return dir;
}

/** 不真正运行测试的检查器（测试本身不应在测试里再跑整套测试）。 */
const passRunner = () => ({ ok: true, output: '' });
const failRunner = () => ({ ok: false, output: '注入的失败' });

/** 一个用户经验的变更集：替换 README 里的一句话，并把版本升到 0.2.1。 */
function userChangeset(id = 'cs-user-1') {
  return {
    id,
    title: '用户经验：收工前必须清理工作树',
    source: 'user',
    rationale: '用户本人的决定',
    bumpTo: '0.2.1',
    ops: [{ op: 'replace', file: 'kit/templates/docs/README.md', from: '活文档', to: '活文档（用户经验）' }],
  };
}

test('提案校验：非法路径、缺依据、缺 source 一律拒绝', () => {
  assert.throws(() => validateChangeset({ ...userChangeset(), ops: [{ op: 'write', file: '../escape', content: 'x' }] }), /非法的 file/);
  assert.throws(() => validateChangeset({ ...userChangeset(), ops: [{ op: 'write', file: 'changesets/x.json', content: 'x' }] }), /非法的 file/);
  assert.throws(() => validateChangeset({ ...userChangeset(), rationale: '' }), /rationale/);
  assert.throws(() => validateChangeset({ ...userChangeset(), source: 'them' }), /source/);
});

test('待确认列表：推荐项在前，其次用户来源在前，agent 提案排在后', () => {
  const dir = bundleCopy();
  proposeChangeset({ bundleDir: dir, changeset: { ...userChangeset('cs-a'), source: 'agent' } });
  proposeChangeset({ bundleDir: dir, changeset: { ...userChangeset('cs-b'), source: 'agent', recommended: true } });
  proposeChangeset({ bundleDir: dir, changeset: { ...userChangeset('cs-c'), source: 'user' } });
  const ids = listPending(dir).map((x) => x.id);
  assert.deepEqual(ids, ['cs-b', 'cs-c', 'cs-a']);
  assert.throws(() => proposeChangeset({ bundleDir: dir, changeset: userChangeset('cs-c') }), /已存在/);
});

test('用户经验：直接应用，内容替换并升级版本，移入 applied 记录', () => {
  const dir = bundleCopy();
  proposeChangeset({ bundleDir: dir, changeset: userChangeset() });
  const r = applyChangeset({ bundleDir: dir, id: 'cs-user-1', checkRunner: passRunner });
  assert.equal(r.ok, true);
  assert.ok(read(dir, 'kit/templates/docs/README.md').includes('活文档（用户经验）'));
  assert.equal(JSON.parse(read(dir, 'bundle.json')).bundleVersion, '0.2.1');
  assert.equal(read(dir, 'kit/VERSION').trim(), '0.2.1');
  assert.ok(fs.existsSync(path.join(dir, 'changesets', 'applied', 'cs-user-1.json')));
  assert.equal(fs.existsSync(path.join(dir, 'changesets', 'pending', 'cs-user-1.json')), false);
});

test('agent 的总结：未经确认不能应用；确认后才应用', () => {
  const dir = bundleCopy();
  proposeChangeset({ bundleDir: dir, changeset: { ...userChangeset('cs-agent-1'), source: 'agent' } });
  assert.throws(() => applyChangeset({ bundleDir: dir, id: 'cs-agent-1', checkRunner: passRunner }), /须先由用户确认/);
  assert.ok(!read(dir, 'kit/templates/docs/README.md').includes('用户经验'), '未确认时不得改动任何文件');
  applyChangeset({ bundleDir: dir, id: 'cs-agent-1', approved: true, checkRunner: passRunner });
  assert.ok(read(dir, 'kit/templates/docs/README.md').includes('用户经验'));
});

test('套件测试失败：改动与版本全部恢复原样，提案仍在待确认列表', () => {
  const dir = bundleCopy();
  const before = read(dir, 'kit/templates/docs/README.md');
  const bundleBefore = read(dir, 'bundle.json');
  proposeChangeset({ bundleDir: dir, changeset: userChangeset('cs-fail') });
  assert.throws(() => applyChangeset({ bundleDir: dir, id: 'cs-fail', checkRunner: failRunner }), /已恢复/);
  assert.equal(read(dir, 'kit/templates/docs/README.md'), before);
  assert.equal(read(dir, 'bundle.json'), bundleBefore);
  assert.equal(read(dir, 'kit/VERSION').trim(), CURRENT);
  assert.deepEqual(listPending(dir).map((x) => x.id), ['cs-fail']);
});

test('替换的原文不唯一：拒绝应用，并恢复', () => {
  const dir = bundleCopy();
  write(dir, 'kit/templates/docs/README.md', '活文档\n活文档\n');
  proposeChangeset({ bundleDir: dir, changeset: userChangeset('cs-dup') });
  assert.throws(() => applyChangeset({ bundleDir: dir, id: 'cs-dup', checkRunner: passRunner }), /恰好出现一次/);
  assert.equal(read(dir, 'kit/templates/docs/README.md'), '活文档\n活文档\n');
});

test('发布：提交整包目录并打版本标签；同一版本不能重复发布', () => {
  const root = tmpRepo();
  write(root, 'README.md', '# 其他内容\n');
  const dir = path.join(root, 'engineering-kit');
  commitAll(root, 'base');
  // 整包目录在基线之后才加入，发布时它是未跟踪的改动
  fs.cpSync(BUNDLE_ROOT, dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}changesets`) && !src.includes(`${path.sep}.git`) });
  // 未提交的无关改动不应被纳入发布提交
  write(root, 'unrelated.txt', 'x\n');
  const r = releaseBundle({ bundleDir: dir, testRunner: passRunner });
  assert.equal(r.tag, `engineering-kit-v${JSON.parse(read(dir, 'bundle.json')).bundleVersion}`);
  assert.ok(git(root, ['tag', '--list', r.tag]).includes(r.tag));
  const files = git(root, ['show', '--name-only', '--format=', 'HEAD']);
  assert.ok(!files.includes('unrelated.txt'), '发布提交只能包含整包目录');
  assert.throws(() => releaseBundle({ bundleDir: dir, testRunner: passRunner }), /已存在/);
});

test('命令行入口：list / propose / apply 能运行，未知子命令用法退出码 2，出错退出码 1', () => {
  const dir = tmpDir('ekit-cli-');
  fs.cpSync(path.join(BUNDLE_ROOT, 'kit', 'gate'), path.join(dir, 'kit', 'gate'), { recursive: true });
  fs.cpSync(path.join(BUNDLE_ROOT, 'kit', 'tools', 'changeset.mjs'), path.join(dir, 'kit', 'tools', 'changeset.mjs'));
  const run = (...args) => spawnSync(process.execPath, [path.join(dir, 'kit', 'tools', 'changeset.mjs'), ...args], { encoding: 'utf8' });
  assert.equal(run('bogus').status, 2);
  assert.equal(run('list').stdout.includes('没有待确认'), true);
  const f = path.join(dir, 'cs.json');
  fs.writeFileSync(f, JSON.stringify({ id: 'cli-1', title: '示例', source: 'agent', rationale: '依据', ops: [{ op: 'write', file: 'x.txt', content: 'x' }] }));
  assert.equal(run('propose', f).status, 0);
  assert.ok(run('list').stdout.includes('cli-1'));
  const r = run('apply', 'cli-1');
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('--approved'), r.stderr);
});
