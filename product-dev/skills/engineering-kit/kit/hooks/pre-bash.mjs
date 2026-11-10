// Claude Code PreToolUse 钩子（Bash / PowerShell）：把推送闸门变成对 agent 的硬约束。
// 业务含义：agent 执行 git push / gh pr create 前先核对闸门，未通过则拒绝执行；直接合并 PR（gh pr merge、
// 或 gh api 调用 pulls/<n>/merge）一律拒绝，合并只经合并入口 merge.mjs（pr 流程）或项目约定的入口。
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

/**
 * 判断命令属于哪一类：merge（拒绝）、push（先核对）、other（放行）。
 * merge 从严：直接在原始文本上匹配，引号里也拦（gh api "…/merge" 不能绕过）。
 * push 只看引号外的命令；sh -c / bash -c 等的引号载荷再分类一次（bash -c "git push" 拦得住）。
 */
export function classify(command, depth = 0) {
  // gh 允许全局选项（-R owner/repo 等），所以用“同一段命令内出现 pr merge”来判断；gh.exe 与 git.exe 同样识别
  if (/\bgh(?:\.exe)?\b[^\n;&|]*\bpr\s+merge\b/.test(command) || /\bgh(?:\.exe)?\b[^\n]*\/pulls\/\d+\/merge/.test(command)) return 'merge';
  const bare = stripQuoted(command);
  const gitPush = /\bgit(?:\.exe)?(?:\s+(?:-C\s+\S+|-c\s+\S+|--?[\w-]+(?:=\S+)?))*\s+push\b/;
  if (gitPush.test(bare) || /\bgh(?:\.exe)?\b[^\n;&|]*\bpr\s+create\b/.test(bare)) return 'push';
  if (depth < 3) {
    const inner = /\b(?:bash|sh|zsh|pwsh|powershell|cmd)\s+(?:-c|-Command|\/c)\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/gi;
    let m;
    while ((m = inner.exec(command)) !== null) {
      const kind = classify(m[1] ?? m[2] ?? '', depth + 1);
      if (kind !== 'other') return kind;
    }
  }
  return 'other';
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
