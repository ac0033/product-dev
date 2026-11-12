// 测试辅助：创建临时 git 仓库、写文件、提交基线。只被测试引用，不会被同步到其他项目。
// 业务含义：闸门逻辑依赖真实 git 状态（分支、工作区、未跟踪文件），所以测试用临时仓库而不是模拟数据。
// 临时目录一律经 tmpDir 建：每个测试文件跑完后（node:test 的 after 钩子）统一删除，不在系统临时目录里留下 ekit-* 目录。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

/** 本测试文件建过的临时目录（tmpDir 登记），文件内全部测试结束后删除。 */
const created = [];

/** 在系统临时目录下新建一个以 prefix 开头的目录，并登记到用完即删的清单里。 */
export function tmpDir(prefix = 'ekit-') {
  return trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** 把别处建的临时目录（如 extractTag 导出的标签目录）也登记进用完即删的清单，返回原路径。 */
export function trackTmp(dir) {
  created.push(dir);
  return dir;
}

/**
 * 删除登记过的临时目录。Windows 上 git 子进程刚退出时文件可能还被占用，删除带重试；
 * 仍删不掉的只跳过、不让测试失败（清理不是被测行为）。返回没删掉的目录。
 */
export function cleanupTmp() {
  const left = [];
  // 倒序删除：后登记的先删（例如指向临时目录的目录连接要先于它指向的目录删掉）
  for (const dir of created.splice(0).reverse()) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      left.push(dir);
    }
  }
  return left;
}

// 本文件的全部测试结束后清理（helpers 被每个测试文件导入，钩子挂在该文件的根上）
after(() => {
  cleanupTmp();
});

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
  const root = tmpDir('ekit-');
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'test']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'commit.gpgsign', 'false']);
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
  const p = path.join(tmpDir('ekit-report-'), 'report.md');
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
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nassert.ok(dedup);\n");
  write(root, 'pass.mjs', 'process.exit(0);\n');
  write(root, 'fail.mjs', 'process.exit(3);\n');
  commitAll(root, 'base');
  git(root, ['checkout', '-q', '-b', 'feat']);
  return root;
}
