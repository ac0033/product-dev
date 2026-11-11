// 测试辅助：创建临时 git 仓库、写文件、提交基线。只被测试引用，不会被同步到其他项目。
// 业务含义：闸门逻辑依赖真实 git 状态（分支、工作区、未跟踪文件），所以测试用临时仓库而不是模拟数据。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 测试用闸门配置：与模板字段一致，但测试数据更小（最短复审字数等）。 */
export const TEST_CONFIG = {
  base: 'main',
  sourceGlobs: ['src/**/*.ts'],
  testGlobs: ['test/**/*.ts'],
  reviewIgnore: ['**/*.md', 'docs/**'],
  commentMode: 'header+exports',
  testCommand: 'node pass.mjs',
  reviewers: ['feature-dev:code-reviewer', '/code-review', 'general-purpose'],
  reviewMinChars: 60,
  reviewKeyword: '结论',
  lockMaxAgeMinutes: 90,
};

/** 源文件头注释：业务职责说明，至少 8 个字。 */
export const SRC_HEADER = '// 去重模块：按标题相似度合并重复资源，是导入流程的一步。\n';

/** 在仓库里执行 git，失败时抛错并带上 stderr，便于定位测试问题。 */
export function git(cwd, args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr}`);
  return r.stdout;
}

/** 新建一个只有 main 分支的空仓库。 */
export function tmpRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ekit-'));
  git(root, ['init', '-q', '-b', 'main']);
  return root;
}

/** 写文件（自动建目录）。 */
export function write(root, rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

/** 复审报告放在仓库之外（与真实流程一致：报告不属于被审代码）。 */
export function reportFile(text) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ekit-report-')), 'report.md');
  fs.writeFileSync(p, text);
  return p;
}

/** 读文件。 */
export function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

/** 暂存全部改动并提交。 */
export function commitAll(root, msg) {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', msg, '--allow-empty']);
}

/**
 * 建一个“基线 main + 功能分支 feat”的仓库：
 * main 上有 src/dedup.ts（带头注释、导出函数）和引用它的测试，以及两个退出码不同的测试脚本。
 * 返回仓库路径，当前分支为 feat，之后的改动即“本次改动”。
 */
export function featureRepo(config = {}) {
  const root = tmpRepo();
  write(root, 'engineering.config.json', JSON.stringify({ ...TEST_CONFIG, ...config }, null, 2));
  write(root, 'src/dedup.ts', `${SRC_HEADER}export function dedup(items: string[]) {\n  return [...new Set(items)];\n}\n`);
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nconsole.log(dedup);\n");
  write(root, 'pass.mjs', 'process.exit(0);\n');
  write(root, 'fail.mjs', 'process.exit(3);\n');
  commitAll(root, 'base');
  git(root, ['checkout', '-q', '-b', 'feat']);
  return root;
}
