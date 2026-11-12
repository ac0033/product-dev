// 一致性检查用的仓库文件清单：按 git 判断哪些文件属于本仓库，不递归扫目录。
// 业务含义：只检查当前这一份仓库的文件；其他工作树、嵌套仓库（如 .claude/worktrees/、改名后的 vendor.off）是别的版本，不参与。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 列出 root 仓库里的文件（相对路径，正斜杠）：已跟踪和未跟踪且未被忽略的，实际存在的才算（已删除未提交的不算）。
 * git 把嵌套仓库（含工作树）只列成一项“目录/”，这里整项丢弃；skipDirs 里的目录名在任何层级都跳过。
 */
export function listRepoFiles(root, skipDirs = new Set()) {
  const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ls-files 失败：${r.stderr}`);
  const files = new Set();
  for (const raw of r.stdout.split('\0')) {
    const rel = raw.replace(/\\/g, '/');
    if (!rel || rel.endsWith('/')) continue; // 嵌套仓库与工作树
    if (rel.split('/').some((seg) => skipDirs.has(seg))) continue;
    // 已跟踪的子模块是一个目录，不是文件；已删除的也不在磁盘上
    if (fs.existsSync(path.join(root, rel)) && fs.statSync(path.join(root, rel)).isFile()) files.add(rel);
  }
  return [...files];
}

/** 错误清单限量：最多显示前 max 项，超出的合并成一行写明总数，避免一处出错刷出上千行。 */
export function capList(list, max = 30) {
  return list.length <= max ? list : [...list.slice(0, max), `……（共 ${list.length} 项，只显示前 ${max} 项）`];
}
