// Claude Code PreToolUse 钩子（Bash / PowerShell）：把推送闸门变成对 agent 的硬约束。
// 业务含义：agent 执行 git push / gh pr create 前先核对闸门，未通过则拒绝执行；直接合并 PR（gh pr merge、
// 或 gh api 调用 pulls/<n>/merge）一律拒绝，合并只经合并入口 merge.mjs（pr 流程）或项目约定的入口。
// 跳过 git 钩子的推送（git push --no-verify 及其缩写、git -c core.hooksPath=… push）一律拒绝：本钩子只核对工作区，
// 实际推送的引用（推别的分支、显式 refspec）由 git 的 pre-push 钩子交给 verify.mjs --pre-push 核对，跳过它就没人核对引用了。
// 输入：stdin 的 JSON（tool_input.command、cwd）。退出码 2 表示拒绝，原因写到 stderr 反馈给 agent。
// 局限：按命令文本切词判断，防误操作，挡不住刻意绕过；终端里直接 git push 不经过本钩子，靠 git pre-push 钩子兜底。
// 钩子自身出错时放行并打印提示，避免钩子故障把整个工作流卡死。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../gate/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const VERIFY = path.join(here, '..', 'gate', 'verify.mjs');

/** 把引号里的内容去掉（只留空引号），使提交说明、grep 关键字里的 “gh pr create” 不被当成命令。 */
function stripQuoted(command) {
  return command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
}

/** 分类结果的优先级：同一条命令里出现多种时取最严的（合并 > 跳过钩子的推送 > 推送 > 其他）。 */
const RANK = { other: 0, push: 1, bypass: 2, merge: 3 };

/**
 * 按 shell 的规则把命令切成段（引号外的 ; & | 换行分段）和词：引号去掉、内容保留（"--no-verify" 与 --no-verify 是同一个词）。
 * 双引号里只有 \" \\ \$ \` 是转义（去掉反斜杠），反斜杠加换行是续行（两个字符都去掉），其余反斜杠原样保留（POSIX sh 的规则；
 * PowerShell 双引号里反斜杠不是转义，Windows 路径 "C:\Program Files\Git\cmd\git.exe" 按这条规则同样原样得到）。
 * 返回 [[词, ...], ...]。只做判断用，不追求完整的 shell 语法（不处理引号外的换行续行、子命令替换的嵌套等）。
 */
export function shellSegments(command) {
  const segs = [];
  let words = [];
  let cur = null;
  const flush = () => {
    if (cur !== null) words.push(cur);
    cur = null;
  };
  const endSeg = () => {
    flush();
    if (words.length) segs.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let text = '';
      for (; j < command.length && command[j] !== ch; j++) {
        const next = command[j + 1];
        if (ch === '"' && command[j] === '\\' && next !== undefined && '"\\$`\n'.includes(next)) {
          j++;
          if (next !== '\n') text += next;
        } else text += command[j];
      }
      cur = (cur ?? '') + text;
      i = j; // 停在收尾引号上（没有收尾引号时到结尾）
    } else if (/[;&|\n]/.test(ch)) endSeg();
    else if (/\s/.test(ch)) flush();
    else cur = (cur ?? '') + ch;
  }
  endSeg();
  return segs;
}

/** git 的可执行文件名（git、git.exe，允许带路径）。 */
const GIT_EXE = /(?:^|[\\/])git(?:\.exe)?$/i;

/** 一个配置项写法（core.hooksPath=…，或 --config-env 的 core.hooksPath=ENV）的键是不是 core.hooksPath（不分大小写）。 */
const isHooksPathKey = (s) => s.split('=')[0].trim().toLowerCase() === 'core.hookspath';

/** 环境变量赋值词：名字=值。 */
const ASSIGN = /^([A-Za-z_]\w*)=(.*)$/s;

/**
 * git push 的识别口径：一段命令里出现 git 可执行文件、其后（跳过全局选项）是 push，就算推送，不论它在段里的什么位置
 * （strace、ssh、dotenv 等任何包装命令之后都认，不靠包装命令清单）。唯一例外：它所在命令的命令词是只输出文本、
 * 不执行参数的命令（TEXT_COMMANDS），这时它的参数里的 git push 不算（echo git push --no-verify 不拦）。
 * 一段里的“命令”从这些位置开始：段首；子命令替换、分组、脚本块的开头（词以 ( $( @( ` { 开头，或单独的 {）；
 * find 的 -exec、-execdir、-ok、-okdir 之后。所以 echo $(git push) 里的 git 属于子命令替换，照样算推送。
 * 找命令词时从命令起点跳过这些前缀：环境变量赋值（名字=值，收集起来供 core.hooksPath 判断）；重定向（>file、2> file）；
 * shell 关键字 if then else elif do while until !；常见包装命令及其选项（WRAPPERS，表里列出的选项带一个独立的值，一并跳过）。
 * WRAPPERS 只用来找命令词（sudo echo … 的命令词是 echo）和收集前缀里的赋值（env -i X=… git push），不限制推送的识别：
 * 不在表里的包装命令本身就是命令词，它不在 TEXT_COMMANDS 里，后面的 git push 照样算。
 */
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!']);
const WRAPPERS = {
  env: { values: ['-u', '--unset', '-C', '--chdir'] },
  command: { values: [] },
  builtin: { values: [] },
  exec: { values: ['-a'] },
  sudo: { values: ['-u', '-g', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '-R', '--user', '--group', '--prompt', '--close-from', '--chdir', '--role', '--type', '--other-user', '--command-timeout', '--chroot'] },
  doas: { values: ['-u', '-C'] },
  nohup: { values: [] },
  time: { values: ['-f', '--format', '-o', '--output'] },
  nice: { values: ['-n', '--adjustment'] },
  timeout: { values: ['-s', '--signal', '-k', '--kill-after'], positional: 1 }, // 时长是一个位置参数
};

/**
 * 只输出文本、不执行参数的命令：它们的参数里的 git push 不是推送。宁少勿多，拿不准的不进清单（不进清单只会偏严）：
 * echo、printf，PowerShell 的 Write-Host、Write-Output、Write-Error，查找文本的 grep、egrep、fgrep、rg、findstr、Select-String。
 * git 自己的子命令（log、grep、commit 等）不在清单里：git commit -m x git push 这种未加引号的参数会按推送核对（偏严）。
 */
const TEXT_COMMANDS = new Set(['echo', 'printf', 'write-host', 'write-output', 'write-error', 'grep', 'egrep', 'fgrep', 'rg', 'findstr', 'select-string']);

/** 命令名：去掉路径和 .exe，转小写（PowerShell 命令不分大小写；/usr/bin/env 与 env 同样识别）。 */
const cmdName = (w) => w.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();

/** 从命令起点 i 起跳过前缀（规则见上），返回命令词的下标；前缀里的环境变量赋值追加到 assigns。 */
function commandAt(words, i, assigns) {
  while (i < words.length) {
    const w = words[i];
    if (w === '') {
      i++;
      continue;
    }
    if (ASSIGN.test(w)) {
      assigns.push(w);
      i++;
      continue;
    }
    if (/^\d*[<>]/.test(w)) {
      i += /^\d*[<>]+$/.test(w) ? 2 : 1; // 单独的 > 后面一个词是重定向目标
      continue;
    }
    const name = cmdName(w);
    if (KEYWORDS.has(name)) {
      i++;
      continue;
    }
    const wrapper = Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : null;
    if (!wrapper) return i;
    i++;
    let positional = wrapper.positional ?? 0;
    while (i < words.length) {
      const o = words[i];
      if (o.startsWith('-')) {
        i += wrapper.values.includes(o) ? 2 : 1;
        continue;
      }
      if (positional > 0) {
        positional--;
        i++;
        continue;
      }
      break; // 包装命令的选项结束：接下来回到外层循环，可能还有赋值（env 的）或另一层包装
    }
  }
  return i;
}

/** git 与子命令之间带一个独立值的全局选项（git.c 的 handle_options；--exec-path 不带独立值，单写时只打印路径就退出）。 */
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--config-env', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--attr-source']);

/**
 * 一段命令的分析：返回 { words, commands: [{ start, at, assigns }] }。
 * words 是去掉了开头的 ( $( @( ` { 与结尾的 ) ` }（括号类符号）的词；env -S（--split-string）的值按 shell 规则拆开拼回原处。
 * commands 是段里各个命令：start 是起点，at 是命令词的下标，assigns 是它前缀里的环境变量赋值。
 */
function analyzeSegment(segWords) {
  const words = [];
  const starts = [0];
  let sawEnv = false;
  for (let i = 0; i < segWords.length; i++) {
    const raw = segWords[i];
    const w = raw.replace(/^(?:\$?\(|@\(|`|\{)+/, '').replace(/[)`}]+$/, '');
    if (sawEnv && (w === '-S' || w === '--split-string') && i + 1 < segWords.length) {
      words.push(...shellSegments(segWords[++i]).flat());
      continue;
    }
    if (cmdName(w) === 'env') sawEnv = true;
    if (words.length > 0 && /^(?:\$?\(|@\(|`|\{)/.test(raw)) starts.push(words.length);
    words.push(w);
    if (/^-(?:exec|execdir|ok|okdir)$/.test(w)) starts.push(words.length);
  }
  const commands = [...new Set(starts)].map((start) => {
    const assigns = [];
    return { start, at: commandAt(words, start, assigns), assigns };
  });
  return { words, commands };
}

/**
 * 下标 at 处是不是 git push：返回 { globals: 全局选项设的配置项, args: push 之后的参数（到本段结束）}，不是时返回 null。
 * 全局选项：-C、-c、--config-env、--git-dir、--work-tree、--namespace 等带独立值（见 GIT_VALUE_OPTS），
 * -c 与 --config-env（也可写成 --config-env=…）的值收集起来；其余 -x / --xxx[=…] 跳过。
 */
function gitPushAt(words, at) {
  if (!GIT_EXE.test(words[at])) return null;
  const globals = [];
  let j = at + 1;
  while (j < words.length && words[j].startsWith('-')) {
    const w = words[j];
    if (GIT_VALUE_OPTS.has(w)) {
      if ((w === '-c' || w === '--config-env') && j + 1 < words.length) globals.push(words[j + 1]);
      j += 2;
    } else {
      if (w.startsWith('--config-env=')) globals.push(w.slice('--config-env='.length));
      j += 1;
    }
  }
  return words[j] === 'push' ? { globals, args: words.slice(j + 1) } : null;
}

/**
 * 一段命令里的全部 git push（口径见上）：逐个词找 git push，再看它属于哪个命令（起点不超过它的最后一个命令）；
 * 它在那个命令的命令词之后、而命令词是只输出文本的命令时不算。
 */
function pushesIn(segWords) {
  const { words, commands } = analyzeSegment(segWords);
  const pushes = [];
  for (let i = 0; i < words.length; i++) {
    const p = gitPushAt(words, i);
    if (!p) continue;
    const owner = commands.filter((c) => c.start <= i).at(-1);
    if (owner && i > owner.at && TEXT_COMMANDS.has(cmdName(words[owner.at] ?? ''))) continue;
    pushes.push(p);
  }
  return pushes;
}

/**
 * 命令里的环境变量赋值有没有把 core.hooksPath 交给 git：GIT_CONFIG_KEY_<n>=core.hooksPath，或 GIT_CONFIG_PARAMETERS 里含 core.hooksPath。
 * 只认赋值位置：命令前缀里的 名字=值（含 env [选项]、sudo 等常见包装命令之后的，见 commandAt；strace 这类不在 WRAPPERS 里的包装之后的赋值不认）、单独一条的赋值语句、export / set 的参数，
 * 以及 PowerShell 的 $env:名字=值（= 两边可有空格）；echo 的参数之类不算。
 * 偏严：不要求赋值作用于那条 git push——同一条命令里任何一处这样的赋值都算（例如 GIT_CONFIG_KEY_0=core.hooksPath git status; git push）。
 * 理由：要准确判断须追踪变量作用域（前缀赋值只作用于一条命令；单独的赋值语句对已导出的变量会影响之后的 git；export 影响之后全部），
 * 判错就是漏拦；把 core.hooksPath 写进 GIT_CONFIG_* 又和推送写在同一条命令里，正常工作几乎遇不到，误拦代价小。
 */
function envSetsHooksPath(segs) {
  const hit = (assign) => {
    const m = ASSIGN.exec(assign);
    if (!m) return false;
    const [, name, value] = m;
    return (/^GIT_CONFIG_KEY_\d+$/i.test(name) && isHooksPathKey(value)) || (/^GIT_CONFIG_PARAMETERS$/i.test(name) && /core\.hookspath/i.test(value));
  };
  for (const words of segs) {
    if (/^\$env:/i.test(words[0] ?? '')) {
      const m = /^\$env:([\w]+)\s*=\s*(.*)$/i.exec(words.join(' '));
      if (m && hit(`${m[1]}=${m[2]}`)) return true;
      continue;
    }
    if (['export', 'set'].includes(words[0])) {
      if (words.slice(1).some(hit)) return true;
      continue;
    }
    if (analyzeSegment(words).commands.some((c) => c.assigns.some(hit))) return true;
  }
  return false;
}

/**
 * 命令里的 git push 与它有没有跳过 git 钩子（逐段按 shell 词判断，引号里的文字不是参数，但被引号包住的整个词照样是参数）：
 *   push 的参数里有 --no-verify（git 接受唯一前缀，--no-veri、--no-verif 同样生效）；-n 是 --dry-run，不算；
 *   git 与 push 之间的全局选项设了 core.hooksPath（-c、--config-env）；
 *   命令里用环境变量（GIT_CONFIG_KEY_<n>、GIT_CONFIG_PARAMETERS）设了 core.hooksPath，且有 git push（偏严，见 envSetsHooksPath）。
 * 返回 { push: 有没有 git push, bypass: 有没有跳过钩子 }。
 * 局限：换行续行（\ 或 `）、变量展开、别名、事先 git config 写进配置文件的都不处理。
 */
function gitPushes(command) {
  const segs = shellSegments(command);
  const pushes = segs.flatMap(pushesIn);
  if (pushes.length === 0) return { push: false, bypass: false };
  const bypass =
    pushes.some((p) => p.args.some((a) => /^--no-veri(?:f|fy)?$/.test(a)) || p.globals.some(isHooksPathKey)) || envSetsHooksPath(segs);
  return { push: true, bypass };
}

/**
 * 判断命令属于哪一类：merge（拒绝）、bypass（跳过 git 钩子的推送，拒绝）、push（先核对）、other（放行）。
 * merge 从严：直接在原始文本上匹配，引号里也拦（gh api "…/merge" 不能绕过）。
 * git push 按 shell 词判断（gitPushes，口径见 pushesIn 上方的说明）；gh pr create 只看引号外的命令；
 * sh -c / bash -c 等的引号载荷再分类一次（bash -c "git push" 拦得住），几种结果取最严的。
 */
export function classify(command, depth = 0) {
  // gh 允许全局选项（-R owner/repo 等），所以用“同一段命令内出现 pr merge”来判断；gh.exe 与 git.exe 同样识别
  if (/\bgh(?:\.exe)?\b[^\n;&|]*\bpr\s+merge\b/.test(command) || /\bgh(?:\.exe)?\b[^\n]*\/pulls\/\d+\/merge/.test(command)) return 'merge';
  const git = gitPushes(command);
  let kind = 'other';
  if (git.bypass) kind = 'bypass';
  else if (git.push || /\bgh(?:\.exe)?\b[^\n;&|]*\bpr\s+create\b/.test(stripQuoted(command))) kind = 'push';
  if (depth < 3) {
    const inner = /\b(?:bash|sh|zsh|pwsh|powershell|cmd)\s+(?:-c|-Command|\/c)\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/gi;
    let m;
    while ((m = inner.exec(command)) !== null) {
      const k = classify(m[1] ?? m[2] ?? '', depth + 1);
      if (RANK[k] > RANK[kind]) kind = k;
    }
  }
  return kind;
}

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }
  const command = String(input?.tool_input?.command ?? '');
  const kind = classify(command);
  if (kind === 'merge') {
    console.error(
      '拒绝：不得直接合并 PR。请用合并入口：node scripts/engineering/gate/merge.mjs <PR>' +
        '（核对 CI 在最终提交上全部通过、代码复审与一致性审记录后才合并；需 modules.gate.reviewFlow 为 pr，未启用的项目按项目约定的入口合并）。',
    );
    process.exit(2);
  }
  if (kind === 'bypass') {
    console.error(
      '拒绝推送：这条 git push 跳过了 git 钩子（--no-verify 或 core.hooksPath）。git 的 pre-push 钩子负责核对实际推送的引用' +
        '（推送的提交须是当前 HEAD 或已在基准分支里），跳过它，没过闸门的提交也推得出去。去掉 --no-verify / core.hooksPath 后重试；' +
        '确需跳过的，向用户说明，由用户决定并在终端里自己执行。',
    );
    process.exit(2);
  }
  if (kind === 'push') {
    const r = spawnSync(process.execPath, [VERIFY], { cwd: input.cwd || process.cwd(), encoding: 'utf8' });
    if (r.error || r.status !== 0) {
      const detail = r.error ? `无法运行闸门：${r.error.message}` : (r.stdout || '') + (r.stderr || '');
      console.error(`拒绝推送：推送闸门未通过。\n${detail}`);
      process.exit(2);
    }
  }
  process.exit(0);
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`推送钩子出错，已放行：${e.message}`);
    process.exit(0);
  }
}
