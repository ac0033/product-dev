// 钩子命令分类测试：推送命令要识别，但引号里的文字（提交说明、grep 关键字）不误拦；合并命令从严识别。
// 业务含义：误拦会让 agent 无法正常工作，漏拦会绕过推送闸门，两者都要测。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { classify } from '../hooks/pre-bash.mjs';
import { featureRepo } from './helpers.mjs';

/** Claude 推送钩子脚本（按真实方式起子进程、从 stdin 传 JSON）。 */
const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'pre-bash.mjs');

test('推送命令：直接、带 -C、链式、经 sh -c 包裹都识别为 push', () => {
  assert.equal(classify('git push -u origin feat'), 'push');
  assert.equal(classify('git -C ../repo push origin feat'), 'push');
  assert.equal(classify('echo hi && git push'), 'push');
  assert.equal(classify('bash -c "git push origin feat"'), 'push');
  assert.equal(classify("sh -c 'gh pr create --draft'"), 'push');
});

test('引号里的文字不算命令：grep 关键字与提交说明不误拦', () => {
  assert.equal(classify('grep -rn "git push" docs'), 'other');
  assert.equal(classify('git commit -m "docs: 说明 git push 的闸门规则"'), 'other');
});

test('合并命令：直接合并与 gh api 合并端点一律识别为 merge（包括引号内）', () => {
  assert.equal(classify('gh pr merge 12 --squash'), 'merge');
  assert.equal(classify('gh api -X PUT repos/x/y/pulls/12/merge'), 'merge');
  assert.equal(classify('gh api -X PUT "repos/x/y/pulls/12/merge"'), 'merge');
});

test('普通命令放行', () => {
  assert.equal(classify('ls -la'), 'other');
  assert.equal(classify('npm test'), 'other');
});

test('跳过 git 钩子的推送：--no-verify（及其缩写）、-c core.hooksPath=… 识别为 bypass；-n 是 --dry-run，照常按 push 核对', () => {
  assert.equal(classify('git push --no-verify origin feat'), 'bypass');
  assert.equal(classify('git push origin feat --no-verify'), 'bypass');
  assert.equal(classify('git push --no-veri origin feat'), 'bypass');
  assert.equal(classify('git -C ../repo push -u --no-verify origin feat'), 'bypass');
  assert.equal(classify('git -c core.hooksPath=/dev/null push origin feat'), 'bypass');
  assert.equal(classify('git -c "core.hooksPath=NUL" push origin feat'), 'bypass');
  assert.equal(classify('echo ok && git push --no-verify'), 'bypass');
  assert.equal(classify('bash -c "git push --no-verify origin feat"'), 'bypass');
  // 不误拦：-n（--dry-run）、--verify、别的命令里的 --no-verify、引号里的文字
  assert.equal(classify('git push -n origin feat'), 'push');
  assert.equal(classify('git push --verify origin feat'), 'push');
  assert.equal(classify('git commit --no-verify -m "x" && git push origin feat'), 'push');
  assert.equal(classify('git commit -m "说明 git push --no-verify 会被拦"'), 'other');
});

/** 以真实方式运行 Claude 推送钩子：stdin 传 { tool_input.command, cwd }。 */
function runHook(command, cwd) {
  return spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_input: { command }, cwd }), encoding: 'utf8' });
}

test('Claude 推送钩子：工作区核对能通过时，git push --no-verify 仍直接拒绝（退出码 2），说明它会跳过 git 的 pre-push 钩子、不再核对推送的引用', () => {
  const root = featureRepo(); // 功能分支上没有改动：推送核对本身通过
  const plain = runHook('git push origin feat', root);
  assert.equal(plain.status, 0, `对照：普通推送应放行：${plain.stderr}`);
  const r = runHook('git push --no-verify origin feat', root);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--no-verify/);
  assert.match(r.stderr, /pre-push/);
  const hooksPath = runHook('git -c core.hooksPath=/dev/null push origin feat', root);
  assert.equal(hooksPath.status, 2, hooksPath.stderr);
  assert.match(hooksPath.stderr, /core.hooksPath/);
});

test('core.hooksPath 只认 git 与 push 之间的全局选项：引号里、别的 git 子命令的参数里出现都不误拦（M1）', () => {
  assert.equal(classify('git commit -m "拒绝 core.hooksPath 的 git push"'), 'other');
  assert.equal(classify('git log --grep "core.hooksPath push"'), 'other');
  assert.equal(classify('git grep core.hooksPath -- push'), 'other');
  assert.equal(classify('git commit -m "改 core.hooksPath" && git push origin feat'), 'push');
  // 真正的全局选项照常拦：-c 带引号、键名大小写不同、--config-env 两种写法
  assert.equal(classify("git -c 'core.hooksPath=/dev/null' push"), 'bypass');
  assert.equal(classify('git -c CORE.HOOKSPATH=x push origin feat'), 'bypass');
  assert.equal(classify('git --config-env=core.hooksPath=HP push'), 'bypass');
  assert.equal(classify('git --config-env core.hooksPath=HP push'), 'bypass');
  assert.equal(classify('git -c core.editor=vim push origin feat'), 'push');
});

test('--no-verify 被引号包住（shell 去引号后 git 仍收到它）也判 bypass；只看 push 段的参数（L1）', () => {
  assert.equal(classify('git push origin "--no-verify"'), 'bypass');
  assert.equal(classify("git push origin '--no-verify'"), 'bypass');
  assert.equal(classify('git push "--no-veri" origin feat'), 'bypass');
  assert.equal(classify('git commit -m "x --no-verify" && git push origin feat'), 'push');
  assert.equal(classify('git commit -m "--no-verify" && git push origin feat'), 'push');
});

test('环境变量设 core.hooksPath（GIT_CONFIG_KEY_n、GIT_CONFIG_PARAMETERS）再 git push 判 bypass；不推送时不管（L1）', () => {
  assert.equal(classify('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git push origin feat'), 'bypass');
  assert.equal(classify("GIT_CONFIG_PARAMETERS=\"'core.hooksPath=/dev/null'\" git push"), 'bypass');
  assert.equal(classify('env GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_COUNT=1 git push'), 'bypass');
  assert.equal(classify('export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath; git push origin feat'), 'bypass');
  assert.equal(classify("$env:GIT_CONFIG_PARAMETERS=\"'core.hooksPath=NUL'\"; git push origin feat"), 'bypass');
  assert.equal(classify('GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_COUNT=1 git status'), 'other');
  assert.equal(classify('GIT_CONFIG_KEY_0=core.editor GIT_CONFIG_COUNT=1 git push'), 'push');
  assert.equal(classify('echo "GIT_CONFIG_KEY_0=core.hooksPath" && git push origin feat'), 'push');
});
