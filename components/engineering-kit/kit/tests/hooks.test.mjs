// 钩子命令分类测试：推送命令要识别，但引号里的文字（提交说明、grep 关键字）不误拦；合并命令从严识别。
// 业务含义：误拦会让 agent 无法正常工作，漏拦会绕过推送闸门，两者都要测。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { classify, shellSegments } from '../hooks/pre-bash.mjs';
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

test('双引号里只认 sh 的转义（反斜杠后跟引号、反斜杠、美元符、反引号、换行），其余反斜杠原样保留：带空格的 Windows 引号路径照样认得出 git，推送与跳过钩子都识别（PR #11 后续 1）', () => {
  assert.equal(classify(String.raw`"C:\Program Files\Git\cmd\git.exe" push origin feat`), 'push');
  assert.equal(classify(String.raw`& "C:\Program Files\Git\cmd\git.exe" push origin feat`), 'push');
  assert.equal(classify(String.raw`& "C:\Program Files\Git\cmd\git.exe" push --no-verify`), 'bypass');
  assert.equal(classify(String.raw`"C:\Program Files\Git\cmd\git.exe" -c core.hooksPath=NUL push`), 'bypass');
  // sh 的转义照常：\" 是一个引号（整段仍是提交说明），"--no-\verify" 里的 \v 原样保留（git 收到的就不是 --no-verify）
  assert.deepEqual(shellSegments(String.raw`git commit -m "说明 \"git push --no-verify\" 会被拦"`, 'sh'), [['git', 'commit', '-m', '说明 "git push --no-verify" 会被拦']]);
  // 两种方言取严（PR #21 M2）：按 PowerShell 方言 \" 不是转义，git push 露在引号外，判 push（偏严，见 SKILL.md 第 6 节）
  assert.equal(classify(String.raw`git commit -m "说明 \"git push --no-verify\" 会被拦"`), 'push');
  assert.equal(classify(String.raw`git push origin "--no-\verify"`), 'push');
});

test('git push 在一段命令里任何位置都算：带独立值的全局选项、env 的选项、任意包装命令之后都认得出；只有只输出文本的命令（echo、grep 等）的参数不算（PR #11 后续 2）', () => {
  // 任意包装命令（不靠清单）
  assert.equal(classify('strace git push --no-verify'), 'bypass');
  assert.equal(classify('ssh h git push --no-verify'), 'bypass');
  assert.equal(classify('dotenv -- git push --no-verify'), 'bypass');
  assert.equal(classify('strace -f git push origin feat'), 'push');
  // 带独立值的全局选项
  assert.equal(classify('git --git-dir x push --no-verify'), 'bypass');
  assert.equal(classify('git --work-tree . --git-dir .git push origin feat'), 'push');
  assert.equal(classify('git --namespace ns push --no-verify'), 'bypass');
  // env 自身的选项之后的赋值
  assert.equal(classify('env -i GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git push'), 'bypass');
  assert.equal(classify('env -u HOME GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_COUNT=1 git push origin feat'), 'bypass');
  assert.equal(classify('env -i git push --no-verify'), 'bypass');
  assert.equal(classify('env -S "git push --no-verify"'), 'bypass');
  // 常见前缀与复合命令
  assert.equal(classify('sudo -u root git push --no-verify'), 'bypass');
  assert.equal(classify('command git push origin feat'), 'push');
  assert.equal(classify('time git push origin feat'), 'push');
  assert.equal(classify('nohup git push origin feat'), 'push');
  assert.equal(classify('timeout 60 git push --no-verify'), 'bypass');
  assert.equal(classify('if git push origin feat; then echo ok; fi'), 'push');
  assert.equal(classify('(git push --no-verify)'), 'bypass');
  assert.equal(classify('echo $(git push origin feat)'), 'push');
  assert.equal(classify('echo `git push --no-verify`'), 'bypass');
  assert.equal(classify('{ git push origin feat; }'), 'push');
  assert.equal(classify('cmd /c git push origin feat'), 'push');
  assert.equal(classify('Get-Item . | ForEach-Object { git push --no-verify }'), 'bypass');
  assert.equal(classify('find . -maxdepth 0 -exec git push --no-verify ;'), 'bypass');
  assert.equal(classify('printf y | xargs -I{} git push origin feat'), 'push');
  // 只输出文本的命令的参数不算（前缀之后的命令词也认）
  assert.equal(classify('echo git push --no-verify'), 'other');
  assert.equal(classify('echo git push'), 'other');
  assert.equal(classify('printf "%s" x git push'), 'other');
  assert.equal(classify('grep -rn git push docs'), 'other');
  assert.equal(classify('Write-Host git push --no-verify'), 'other');
  assert.equal(classify('X=1 echo git push --no-verify'), 'other');
  assert.equal(classify('echo git push; git push origin feat'), 'push');
  assert.equal(classify('git commit -m "说明 git push --no-verify 会被拦"'), 'other');
  // 偏严：git 的子命令不在文本命令清单里，未加引号的参数里的 git push 照样按推送核对（git 实际不会推送）
  assert.equal(classify('git commit -m x git push'), 'push');
});

test('文本命令例外只在命令里没有可再执行结构时适用：管道、重定向、子命令替换、eval / source / iex / . 一出现就按推送判（PR #21 M1）', () => {
  assert.equal(classify('echo git push --no-verify origin | sh'), 'bypass');
  assert.equal(classify('echo git push --no-verify origin | bash'), 'bypass');
  assert.equal(classify('Write-Output git push --no-verify | Invoke-Expression'), 'bypass');
  assert.equal(classify('Write-Output git push --no-verify | iex'), 'bypass');
  assert.equal(classify('printf "%s " git push --no-verify | sh'), 'bypass');
  assert.equal(classify('sudo echo git push --no-verify | sudo sh'), 'bypass');
  assert.equal(classify('$(echo git push --no-verify origin)'), 'bypass');
  assert.equal(classify('`echo git push --no-verify origin`'), 'bypass');
  assert.equal(classify('eval $(echo git push --no-verify)'), 'bypass');
  assert.equal(classify('echo git push --no-verify > p.sh; sh p.sh'), 'bypass');
  assert.equal(classify('bash -c "echo git push --no-verify | sh"'), 'bypass');
  assert.equal(classify('bash -c "echo git push --no-verify" | sh'), 'bypass');
  assert.equal(classify('source <(echo git push --no-verify)'), 'bypass');
  assert.equal(classify('. <(echo git push --no-verify)'), 'bypass');
  assert.equal(classify('iex "x"; echo git push --no-verify'), 'bypass');
  // 没有可再执行结构时，文本命令的参数照旧不算
  assert.equal(classify('echo git push --no-verify'), 'other');
  assert.equal(classify('grep -rn git push docs'), 'other');
  assert.equal(classify('Write-Host git push --no-verify'), 'other');
});

test('PR #21 低级项：重定向切成独立词、env -S 只认 env 的选项区、--shallow-file、export/set 不分大小写、包装命令选项值补全（L1–L5、L7）', () => {
  // L1 引号外的 < > 连同前导数字与 & 切成独立词
  assert.equal(classify('git push>/dev/null'), 'push');
  assert.equal(classify('git push --no-verify>out.txt'), 'bypass');
  assert.equal(classify('git push origin feat 2>&1'), 'push');
  assert.equal(classify('git push --no-verify&>log.txt'), 'bypass');
  // L3、L5 env -S 只在 env 自身的选项区认，支持 -S<值> 与 --split-string=<值>
  assert.equal(classify('env X=1 git commit -m msg -S "note git push --no-verify"'), 'other');
  assert.equal(classify('env -S"git push --no-verify"'), 'bypass');
  assert.equal(classify('env --split-string="git push --no-verify"'), 'bypass');
  assert.equal(classify('env -i -S "git push --no-verify"'), 'bypass');
  // L4 --shallow-file 带独立值
  assert.equal(classify('git --shallow-file x push --no-verify'), 'bypass');
  // L7 export / set 不分大小写（cmd 的 Set）
  assert.equal(classify('Set GIT_CONFIG_KEY_0=core.hooksPath && git push'), 'bypass');
  assert.equal(classify('EXPORT GIT_CONFIG_KEY_0=core.hooksPath; git push'), 'bypass');
  // L2 包装命令带值的选项：值不被当成命令词，命令词仍是 echo
  assert.equal(classify('doas -a style echo git push --no-verify'), 'other');
  assert.equal(classify('env -P /bin echo git push --no-verify'), 'other');
  assert.equal(classify('sudo -h host echo git push --no-verify'), 'other');
  assert.equal(classify('sudo -c cls echo git push --no-verify'), 'other');
});

test('两种引号方言各切一遍取较严：PowerShell 里以反斜杠结尾的双引号路径不吞掉后面的命令，引号外反引号转义也认（PR #21 M2）', () => {
  assert.equal(classify(String.raw`cd "D:\proj\"; git push --no-verify`), 'bypass');
  assert.equal(classify(String.raw`git -C "D:\proj\" push --no-verify`), 'bypass');
  assert.equal(classify(String.raw`git -C "D:\proj\" push origin x`), 'push');
  assert.equal(classify(String.raw`cd "D:\proj\" ; gh pr create --title "t"`), 'push');
  assert.equal(classify(String.raw`cd "D:\proj\"; GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_COUNT=1 git push`), 'bypass');
  assert.equal(classify(String.raw`cd "D:\proj\" | echo "x"; echo git push --no-verify`), 'bypass');
  // 反过来：按 PowerShell 方言 \" 不转义会吞掉后面的命令，sh 方言才认得出（两种方言缺一不可）
  assert.equal(classify(String.raw`git commit -m "a\"b" && git push --no-verify`), 'bypass');
  // PowerShell 方言的切词：引号里连写两个引号是一个引号，引号外反引号转义下一个字符
  assert.deepEqual(shellSegments('echo "a""b" \'it\'\'s\'', 'ps'), [['echo', 'a"b', "it's"]]);
  assert.deepEqual(shellSegments('git push --no-ver`ify', 'ps'), [['git', 'push', '--no-verify']]);
  assert.equal(classify(String.raw`& "C:\Program Files\Git\cmd\git.exe" push --no-verify`), 'bypass');
  assert.equal(classify('git push --no-ver`ify'), 'bypass');
  assert.equal(classify("git commit -m 'it''s fine' && git push --no-verify"), 'bypass');
  // sh 方言的转义：按 PowerShell 方言 \" 不是转义，提交说明里的 git push 会露在引号外，取严后判 push（偏严，见 SKILL.md 第 6 节）
  assert.equal(classify(String.raw`git commit -m "a \"git push --no-verify\" b"`), 'push');
  assert.equal(classify('git commit -m "说明 git push --no-verify 会被拦"'), 'other');
});

test('文本命令例外在 ( $( { 开头的子命令里不适用：子表达式的输出总会交给别的命令（PR #21 L1）', () => {
  assert.equal(classify('Set-Content p.ps1 -Value (echo git push --no-verify); & ./p.ps1'), 'bypass');
  assert.equal(classify('Add-Content p.ps1 (Write-Output git push --no-verify); & ./p.ps1'), 'bypass');
  assert.equal(classify('{ echo git push --no-verify; }'), 'bypass');
  assert.equal(classify('echo git push --no-verify'), 'other');
});
