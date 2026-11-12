// 仓库文件清单的边界测试：一致性检查只能看当前这一份仓库的文件，不能越过工作树、嵌套仓库去扫别的副本。
// 业务含义：在主仓库根目录运行时，.claude/worktrees/ 下的其他工作树（整份仓库副本）不得被当成本仓库内容检查。
// 每个用例在临时 git 仓库里跑真实 git，不模拟。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { capList, listRepoFiles } from './repo-files.mjs';

const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}：${r.stderr}`);
}

function write(root, rel, text = 'x\n') {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

/** 临时仓库：一个已提交文件、一个已提交后删除的文件、一个新增未跟踪文件、一个被忽略的文件。 */
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repofiles-'));
  made.push(root);
  git(root, 'init', '-q', '.');
  git(root, 'config', 'core.excludesFile', ''); // 不受本机全局忽略文件影响
  write(root, '.gitignore', '/ignored/\n');
  write(root, 'docs/a.md');
  write(root, 'docs/gone.md');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  fs.rmSync(path.join(root, 'docs/gone.md'));
  write(root, 'docs/new.md');
  write(root, 'ignored/i.md');
  return root;
}

const CURRENT = ['.gitignore', 'docs/a.md', 'docs/new.md'];

test('文件清单：已跟踪和未跟踪未忽略的文件算，已删除的和被忽略的不算', () => {
  assert.deepEqual(listRepoFiles(repo()).sort(), CURRENT);
});

test('文件清单：.claude/worktrees 下的其他工作树整个不检查（主仓库根目录运行的场景）', () => {
  const root = repo();
  git(root, 'worktree', 'add', '-q', '.claude/worktrees/wt1', '-b', 'wt1');
  write(root, '.claude/worktrees/wt1/docs/other.md');
  assert.deepEqual(listRepoFiles(root).sort(), CURRENT);
});

test('文件清单：未被忽略的嵌套仓库（如改名后的 vendor.off）不检查，当前仓库的文件照常列出', () => {
  const root = repo();
  write(root, 'vendor.off/impeccable/README.md');
  git(path.join(root, 'vendor.off/impeccable'), 'init', '-q', '.');
  assert.deepEqual(listRepoFiles(root).sort(), CURRENT);
});

test('文件清单：skipDirs 里的目录名在任何层级都不检查', () => {
  const root = repo();
  write(root, 'docs/.notes/private.md');
  assert.deepEqual(listRepoFiles(root, new Set(['.notes'])).sort(), CURRENT);
  assert.ok(listRepoFiles(root).includes('docs/.notes/private.md'));
});

test('输出限量：超过上限只显示前若干项并写明总数', () => {
  const list = Array.from({ length: 50 }, (_, i) => `项${i}`);
  const out = capList(list, 5);
  assert.equal(out.length, 6);
  assert.match(out[5], /共 50 项/);
  assert.deepEqual(capList(['a', 'b'], 5), ['a', 'b']);
});
