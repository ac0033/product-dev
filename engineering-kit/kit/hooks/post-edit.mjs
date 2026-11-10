// Claude Code PostToolUse 钩子（Edit / Write / MultiEdit）：写完源文件后立即提醒缺测试或缺注释。
// 业务含义：问题在写的当下暴露，比推送时才发现便宜。只提醒，不回滚内容。
// 输入：stdin 的 JSON（tool_input.file_path、cwd）。有问题时退出码 2，提醒写到 stderr 反馈给 agent；否则静默放行。
// 只检查“有没有测试引用”（不要求测试此刻一起改），测试是否随改动一起改由推送闸门判断。
import fs from 'node:fs';
import path from 'node:path';
import { checkComments } from '../gate/check-comments.mjs';
import { checkTestFirst } from '../gate/check-test-first.mjs';
import { isSourceFile, loadConfig, loadExempt, repoRoot } from '../gate/lib.mjs';

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }
  const abs = String(input?.tool_input?.file_path ?? '');
  if (!abs) process.exit(0);
  const cwd = input.cwd || path.dirname(abs);
  const root = repoRoot(cwd);
  const rel = path.relative(root, abs).replace(/\\/g, '/');
  const config = loadConfig(root);
  if (!isSourceFile(rel, config)) process.exit(0);
  const exempt = loadExempt(root);
  const problems = [
    ...checkTestFirst({ root, changed: [rel], config, exempt: exempt.testFirst, requireTestChange: false }).map((p) => p.message),
    ...checkComments({ root, files: [rel], config, exempt: exempt.comments }).map((p) => p.message),
  ];
  if (problems.length > 0) {
    console.error(`提醒（未阻止写入，请在提交前修好）：\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(2);
  }
  process.exit(0);
}

try {
  main();
} catch (e) {
  console.error(`编辑钩子出错，已放行：${e.message}`);
  process.exit(0);
}
