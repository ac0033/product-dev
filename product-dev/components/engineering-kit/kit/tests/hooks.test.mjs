// 钩子命令分类测试：推送命令要识别，但引号里的文字（提交说明、grep 关键字）不误拦；合并命令从严识别。
// 业务含义：误拦会让 agent 无法正常工作，漏拦会绕过推送闸门，两者都要测。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify } from '../hooks/pre-bash.mjs';

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
