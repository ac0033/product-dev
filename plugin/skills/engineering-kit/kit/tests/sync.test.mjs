// 同步测试：一键把工程闸门装进目标项目，并保证可重复执行、不覆盖本地修改、不破坏已有配置。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { syncKit, checkKit } from '../sync.mjs';
import { tmpRepo, write, read, commitAll } from './helpers.mjs';

/** 目标项目：一个有 .claude 目录与已有钩子的 git 仓库，用来检查合并而不覆盖。 */
function targetRepo() {
  const root = tmpRepo();
  write(root, 'README.md', '# 目标项目\n');
  commitAll(root, 'base');
  return root;
}

test('试运行（dry-run）：不写任何文件，只返回计划', () => {
  const root = targetRepo();
  const plan = syncKit({ target: root, dryRun: true });
  assert.ok(plan.actions.length > 0);
  assert.equal(fs.existsSync(path.join(root, 'scripts/engineering')), false);
  assert.equal(fs.existsSync(path.join(root, 'engineering.config.json')), false);
});

test('首次同步：安装闸门脚本、配置模板、锁文件、Claude 钩子与 git pre-push', () => {
  const root = targetRepo();
  const r = syncKit({ target: root });
  assert.equal(r.ok, true, r.messages.join('\n'));
  for (const f of [
    'scripts/engineering/gate/gate.mjs',
    'scripts/engineering/gate/verify.mjs',
    'scripts/engineering/gate/review.mjs',
    'scripts/engineering/gate/lib.mjs',
    'scripts/engineering/hooks/pre-bash.mjs',
    'scripts/engineering/hooks/post-edit.mjs',
    'scripts/engineering/kit.lock.json',
    'engineering.config.json',
    'scripts/engineering/exempt.json',
  ]) {
    assert.equal(fs.existsSync(path.join(root, f)), true, `缺少 ${f}`);
  }
  const settings = JSON.parse(read(root, '.claude/settings.json'));
  const cmds = JSON.stringify(settings.hooks);
  assert.match(cmds, /scripts\/engineering\/hooks\/pre-bash\.mjs/);
  assert.match(cmds, /scripts\/engineering\/hooks\/post-edit\.mjs/);
  const hook = read(root, '.git/hooks/pre-push');
  assert.match(hook, /engineering-kit:pre-push/);
  assert.match(hook, /scripts\/engineering\/gate\/verify\.mjs/);
});

test('重复同步：无改动，第二次不产生写入', () => {
  const root = targetRepo();
  syncKit({ target: root });
  const second = syncKit({ target: root });
  const writes = second.actions.filter((a) => a.type !== 'skip' && a.type !== 'keep');
  assert.equal(writes.length, 0, JSON.stringify(second.actions));
  const settings = JSON.parse(read(root, '.claude/settings.json'));
  assert.equal(settings.hooks.PreToolUse.length, 1, '钩子不应重复写入');
  assert.equal(settings.hooks.PostToolUse.length, 1);
});

test('本地修改过的闸门文件：默认不覆盖并报告冲突；--force 才覆盖', () => {
  const root = targetRepo();
  syncKit({ target: root });
  write(root, 'scripts/engineering/gate/lib.mjs', '// 本地改过的版本\n');
  const r = syncKit({ target: root });
  assert.equal(read(root, 'scripts/engineering/gate/lib.mjs'), '// 本地改过的版本\n');
  assert.ok(r.conflicts.some((c) => c.endsWith('lib.mjs')), JSON.stringify(r.conflicts));
  const forced = syncKit({ target: root, force: true });
  assert.notEqual(read(root, 'scripts/engineering/gate/lib.mjs'), '// 本地改过的版本\n');
  assert.equal(forced.conflicts.length, 0);
});

test('已有 .claude/settings.json：保留原有配置，只追加本套件的钩子', () => {
  const root = targetRepo();
  write(
    root,
    '.claude/settings.json',
    JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'echo keep' }] }] } }, null, 2),
  );
  syncKit({ target: root });
  const s = JSON.parse(read(root, '.claude/settings.json'));
  assert.deepEqual(s.permissions, { allow: ['Bash(npm test)'] });
  assert.equal(s.hooks.PreToolUse.length, 2, '原有 Read 钩子应保留，并追加 pre-bash');
  assert.ok(JSON.stringify(s.hooks).includes('echo keep'));
});

test('已有的 settings.json 不是合法 JSON：报错且不写入任何文件', () => {
  const root = targetRepo();
  write(root, '.claude/settings.json', '{ 这不是 json');
  assert.throws(() => syncKit({ target: root }), /settings\.json/);
  assert.equal(fs.existsSync(path.join(root, 'scripts/engineering')), false, '校验失败时不应写入闸门文件');
});

test('配置文件只在首次创建；同步时只做格式迁移，项目的取值保持不变', () => {
  const root = targetRepo();
  syncKit({ target: root });
  write(root, 'engineering.config.json', '{"base":"origin/dev"}\n');
  const r = syncKit({ target: root });
  assert.ok(r.actions.some((a) => a.type === 'migrate' && a.file === 'engineering.config.json'), JSON.stringify(r.actions));
  const cfg = JSON.parse(read(root, 'engineering.config.json'));
  assert.equal(cfg.profile, 2, '旧扁平配置迁移为 profile 结构');
  assert.equal(cfg.modules.gate.base, 'origin/dev', '项目取值必须保留');
  // 已经是 profile 的配置不再改动
  const again = syncKit({ target: root });
  assert.equal(again.actions.find((a) => a.file === 'engineering.config.json').type, 'keep');
});

test('已有的其他 pre-push 钩子：不覆盖，并给出提示', () => {
  const root = targetRepo();
  write(root, '.git/hooks/pre-push', '#!/bin/sh\necho mine\n');
  const r = syncKit({ target: root });
  assert.equal(read(root, '.git/hooks/pre-push'), '#!/bin/sh\necho mine\n');
  assert.ok(r.messages.some((m) => /pre-push/.test(m)));
});

test('检查模式：列出漂移文件，不写入', () => {
  const root = targetRepo();
  syncKit({ target: root });
  write(root, 'scripts/engineering/gate/verify.mjs', '// 改过\n');
  fs.rmSync(path.join(root, 'scripts/engineering/hooks/post-edit.mjs'));
  const drift = checkKit({ target: root });
  assert.ok(drift.some((d) => d.file.endsWith('verify.mjs') && d.state === 'modified'), JSON.stringify(drift));
  assert.ok(drift.some((d) => d.file.endsWith('post-edit.mjs') && d.state === 'missing'), JSON.stringify(drift));
  assert.equal(read(root, 'scripts/engineering/gate/verify.mjs'), '// 改过\n');
});
