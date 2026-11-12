// Claude Code PreToolUse 钩子（Bash / PowerShell）：把推送闸门变成对 agent 的硬约束。
// 业务含义：agent 执行 git push / gh pr create 前先核对闸门，未通过则拒绝执行；直接合并 PR（gh pr merge、
// 或 gh api 调用 pulls/<n>/merge）一律拒绝，合并只经合并入口 merge.mjs（pr 流程）或项目约定的入口。
// 跳过 git 钩子的推送（git push --no-verify 及其缩写、git -c core.hooksPath=… push）一律拒绝：本钩子只核对工作区，
// 实际推送的引用（推别的分支、显式 refspec）由 git 的 pre-push 钩子交给 verify.mjs --pre-push 核对，跳过它就没人核对引用了。
// 输入：stdin 的 JSON（tool_input.command、cwd）。退出码 2 表示拒绝，原因写到 stderr 反馈给 agent。
// 局限：按命令文本正则判断，防误操作，挡不住刻意绕过；终端里直接 git push 不经过本钩子，靠 git pre-push 钩子兜底。
// 钩子自身出错时放行并打印提示，避免钩子故障把整个工作流卡死。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../gate/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const VERIFY = path.join(here, '..', 'gate', 'verify.mjs');

/** 把引号里的内容去掉（只留空引号），使提交说明、grep 关键字里的 “git push” 不被当成命令。 */
function stripQuoted(command) {
  return command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
}

/** 分类结果的优先级：同一条命令里出现多种时取最严的（合并 > 跳过钩子的推送 > 推送 > 其他）。 */
const RANK = { other: 0, push: 1, bypass: 2, merge: 3 };

/** 一段 git push 命令：全局选项（-C、-c、--xxx）在第 1 组，push 之后到本段结束（; & | 换行）的参数在第 2 组。 */
const GIT_PUSH = /\bgit(?:\.exe)?((?:\s+(?:-C\s+\S+|-c\s+\S+|--?[\w-]+(?:=\S+)?))*)\s+push\b([^\n;&|]*)/g;

/**
 * 按 shell 的规则把命令切成段（引号外的 ; & | 换行分段）和词：引号去掉、内容保留（"--no-verify" 与 --no-verify 是同一个词），
 * 双引号里认反斜杠转义。返回 [[词, ...], ...]。只做判断用，不追求完整的 shell 语法（不处理换行续行、子命令替换等）。
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
        if (ch === '"' && command[j] === '\\' && j + 1 < command.length) text += command[++j];
        else text += command[j];
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

/**
 * 一段命令里的 git push：返回 { globals: 全局选项设的配置项, args: push 之后的参数 }，不是 git push 时返回 null。
 * git 与子命令之间的全局选项：-C <路径>、-c <键=值>、--config-env <键=环境变量>（也可写成 --config-env=…），其余 -x / --xxx[=…] 跳过。
 */
function gitPushIn(words) {
  for (let i = 0; i < words.length; i++) {
    if (!GIT_EXE.test(words[i])) continue;
    const globals = [];
    let j = i + 1;
    while (j < words.length && words[j].startsWith('-')) {
      const w = words[j];
      if (w === '-C' || w === '-c' || w === '--config-env') {
        if (w !== '-C' && j + 1 < words.length) globals.push(words[j + 1]);
        j += 2;
      } else {
        if (w.startsWith('--config-env=')) globals.push(w.slice('--config-env='.length));
        j += 1;
      }
    }
    if (words[j] === 'push') return { globals, args: words.slice(j + 1) };
  }
  return null;
}

/**
 * 命令里的环境变量赋值有没有把 core.hooksPath 交给 git：GIT_CONFIG_KEY_<n>=core.hooksPath，或 GIT_CONFIG_PARAMETERS 里含 core.hooksPath。
 * 只认赋值位置：一段命令开头的 名字=值（前面可有 env、export、set），以及 PowerShell 的 $env:名字=值（= 两边可有空格）；echo 的参数之类不算。
 */
function envSetsHooksPath(segs) {
  const hit = (name, value) =>
    (/^GIT_CONFIG_KEY_\d+$/i.test(name) && isHooksPathKey(value)) || (/^GIT_CONFIG_PARAMETERS$/i.test(name) && /core\.hookspath/i.test(value));
  for (const words of segs) {
    let i = 0;
    if (/^\$env:/i.test(words[0] ?? '')) {
      const joined = words.join(' ');
      const m = /^\$env:([\w]+)\s*=\s*(.*)$/i.exec(joined);
      if (m && hit(m[1], m[2])) return true;
      continue;
    }
    if (['env', 'export', 'set'].includes(words[0])) i = 1;
    for (; i < words.length; i++) {
      const m = /^([A-Za-z_]\w*)=(.*)$/s.exec(words[i]);
      if (!m) break;
      if (hit(m[1], m[2])) return true;
    }
  }
  return false;
}

/**
 * 命令里有没有跳过 git 钩子的 git push（逐段按 shell 词判断，引号里的文字不是参数，但被引号包住的整个词照样是参数）：
 *   push 的参数里有 --no-verify（git 接受唯一前缀，--no-veri、--no-verif 同样生效）；-n 是 --dry-run，不算；
 *   git 与 push 之间的全局选项设了 core.hooksPath（-c、--config-env）；
 *   命令里用环境变量（GIT_CONFIG_KEY_<n>、GIT_CONFIG_PARAMETERS）设了 core.hooksPath，且有 git push。
 * 局限：换行续行（\ 或 `）、子命令替换、别名、事先 git config 写进配置文件的都不处理。
 */
function skipsGitHooks(command) {
  const segs = shellSegments(command);
  const pushes = segs.map(gitPushIn).filter(Boolean);
  if (pushes.length === 0) return false;
  for (const p of pushes) {
    if (p.args.some((a) => /^--no-veri(?:f|fy)?$/.test(a))) return true;
    if (p.globals.some(isHooksPathKey)) return true;
  }
  return envSetsHooksPath(segs);
}

/**
 * 判断命令属于哪一类：merge（拒绝）、bypass（跳过 git 钩子的推送，拒绝）、push（先核对）、other（放行）。
 * merge 从严：直接在原始文本上匹配，引号里也拦（gh api "…/merge" 不能绕过）。
 * push 与 bypass 只看引号外的命令；sh -c / bash -c 等的引号载荷再分类一次（bash -c "git push" 拦得住），几种结果取最严的。
 */
export function classify(command, depth = 0) {
  // gh 允许全局选项（-R owner/repo 等），所以用“同一段命令内出现 pr merge”来判断；gh.exe 与 git.exe 同样识别
  if (/\bgh(?:\.exe)?\b[^\n;&|]*\bpr\s+merge\b/.test(command) || /\bgh(?:\.exe)?\b[^\n]*\/pulls\/\d+\/merge/.test(command)) return 'merge';
  const bare = stripQuoted(command);
  let kind = 'other';
  if (skipsGitHooks(command)) kind = 'bypass';
  else if (new RegExp(GIT_PUSH.source).test(bare) || /\bgh(?:\.exe)?\b[^\n;&|]*\bpr\s+create\b/.test(bare)) kind = 'push';
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
