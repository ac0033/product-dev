// 工程能力包同步器（源端入口）：把整包一键装进项目，整包升级，整包漂移检查，按标签回滚。
// 业务含义：同步是原子事务（见 tools/bundle-lib.mjs）：先校验整包并算出全部改动，再统一写入，
// 再冒烟测试，最后写锁文件；任一步失败整体回滚，项目不留半成品。
// 所有权：套件文件覆盖更新（项目有未登记的本地修改则冲突，--force 才覆盖）；规则只替换标记块；
// 项目配置与豁免表只在首次创建（配置格式不同时只做格式迁移）；.claude/settings.json 只追加钩子。
// 用法（在套件目录或任意位置，目标是项目根）：
//   node sync.mjs --target <项目>                      安装或升级到当前整包版本
//   node sync.mjs --target <项目> --dry-run            只列出计划，不写入
//   node sync.mjs --target <项目> --check              整包漂移检查（有差异退出码 1）
//   node sync.mjs --target <项目> --from-tag <标签>    回滚（或安装）到源仓库的某个版本标签
//   node sync.mjs --target <项目> --init --profile ts|python   从零开始：非 git 目录先 git init -b main，并按技术栈写入配置与脚手架
//   加 --force 覆盖项目里有本地修改的套件文件；加 --no-hooks 不安装钩子
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain, git, repoRoot } from './gate/lib.mjs';
import { checkBundle, executePlan, loadBundle, planBundle } from './tools/bundle-lib.mjs';
import { PRESETS, projectName } from './tools/presets.mjs';

/** 整包根目录（本文件所在 kit 目录的上一级，即 engineering-kit/）。 */
export const BUNDLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 同步整包到项目。返回 { ok, version, dryRun, actions, conflicts, messages }。
 * 选项：bundleRoot（默认当前整包；回滚时指向标签导出的目录）、force、hooks、dryRun、inject（仅测试）、
 *   preset（技术栈预设，仅首次创建配置时生效）、init（目标不是 git 仓库时，允许自动 git init -b main）。
 * 非 git 目录又未指定 init 时拒绝安装：闸门与钩子都依赖 git，不能装一半。
 */
export function syncKit({ target, dryRun = false, force = false, hooks = true, bundleRoot = BUNDLE_ROOT, inject, preset = null, init = false } = {}) {
  const root = path.resolve(target);
  const bundle = loadBundle(bundleRoot);
  const notes = [];
  if (hooks && !fs.existsSync(path.join(root, '.git'))) {
    if (!init) {
      return { ok: false, version: bundle.bundleVersion, dryRun, actions: [], conflicts: [], messages: ['目标目录不是 git 仓库。闸门与钩子依赖 git：加 --init 自动执行 git init -b main 后再安装'] };
    }
    if (dryRun) notes.push('试运行：将执行 git init -b main（试运行不实际初始化）');
    else {
      fs.mkdirSync(root, { recursive: true });
      const r = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git init 失败：${r.stderr}`);
      notes.push('已执行 git init -b main');
    }
  }
  const plan = planBundle({ root, bundleRoot, bundle, force, hooks, preset, projectName: projectName(root) });
  // 原子同步：存在未处理的冲突时整包一个文件也不写，列出冲突，由用户处理或 --force 覆盖
  const blocked = plan.conflicts.length > 0 && !force;
  if (!dryRun && !blocked) executePlan({ root, bundleRoot, bundle, plan, opts: { inject } });
  const messages = [...notes, ...(blocked ? [...plan.messages, '存在冲突：整包未写入（原子同步）。请处理冲突，或确认后加 --force 覆盖。'] : plan.messages)];
  return {
    ok: !blocked,
    version: bundle.bundleVersion,
    dryRun,
    actions: plan.actions,
    conflicts: plan.conflicts,
    messages,
  };
}

/** 兼容旧接口：返回每个套件文件的 { file, state }。 */
export function checkKit({ target, bundleRoot = BUNDLE_ROOT } = {}) {
  return checkBundle({ root: path.resolve(target), bundleRoot }).items.map((i) => ({ file: i.file, state: i.state }));
}

/**
 * 把某个 git 标签下的整包导出到临时目录，返回目录路径（用于回滚或安装旧版本）。
 * 标签位于套件所在的源仓库（skills 仓库）中，路径为 engineering-kit/。
 */
export function extractTag(tag, bundleDir = BUNDLE_ROOT) {
  const top = repoRoot(bundleDir);
  const rel = path.relative(top, bundleDir).replace(/\\/g, '/');
  const ref = git(top, ['rev-parse', '--verify', '--quiet', `${tag}^{commit}`]);
  if (!ref.ok) throw new Error(`找不到版本标签 ${tag}`);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), `ekit-${tag}-`));
  const files = git(top, ['ls-tree', '-r', '--name-only', tag, rel]);
  if (!files.ok) throw new Error(`读取标签 ${tag} 失败`);
  for (const f of files.out.split('\n').filter(Boolean)) {
    const body = spawnSync('git', ['-C', top, 'show', `${tag}:${f}`], { encoding: 'buffer' });
    if (body.status !== 0) throw new Error(`读取 ${tag}:${f} 失败`);
    const dst = path.join(out, path.relative(rel, f));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, body.stdout);
  }
  return out;
}

/** 解析命令行参数。 */
function parseArgs(argv) {
  const val = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const flags = new Set(argv);
  return {
    target: val('--target'),
    fromTag: val('--from-tag'),
    dryRun: flags.has('--dry-run'),
    force: flags.has('--force'),
    hooks: !flags.has('--no-hooks'),
    check: flags.has('--check'),
    init: flags.has('--init'),
    profile: val('--profile'),
  };
}

if (isMain(import.meta.url)) {
  const a = parseArgs(process.argv.slice(2));
  if (!a.target) {
    console.error('用法：node sync.mjs --target <项目目录> [--dry-run] [--force] [--no-hooks] [--check] [--from-tag <标签>] [--init] [--profile ts|python]');
    process.exit(2);
  }
  if (a.profile !== undefined && !PRESETS[a.profile]) {
    console.error(`未知技术栈 ${a.profile}，可选：${Object.keys(PRESETS).join('、')}`);
    process.exit(2);
  }
  try {
    const bundleRoot = a.fromTag ? extractTag(a.fromTag) : BUNDLE_ROOT;
    if (a.check) {
      const rep = checkBundle({ root: path.resolve(a.target), bundleRoot });
      const bad = rep.items.filter((i) => i.state !== 'ok');
      console.log(`整包 ${rep.bundleVersion}，项目安装的是 ${rep.installedVersion ?? '未安装'}`);
      for (const i of bad) console.log(`  [${i.state}] ${i.component}  ${i.file}${i.detail ? `  (${i.detail})` : ''}`);
      console.log(bad.length === 0 ? '整包与清单一致' : `有 ${bad.length} 项与清单不一致`);
      process.exit(bad.length === 0 ? 0 : 1);
    }
    const r = syncKit({ target: a.target, dryRun: a.dryRun, force: a.force, hooks: a.hooks, bundleRoot, init: a.init, preset: a.profile ? PRESETS[a.profile] : null });
    console.log(`${r.dryRun ? '[试运行] ' : ''}整包版本 ${r.version}${a.fromTag ? `（来自标签 ${a.fromTag}）` : ''}`);
    for (const x of r.actions) console.log(`  [${x.type}] ${x.file}`);
    for (const m of r.messages) console.log(`  ! ${m}`);
    console.log(r.ok ? '同步完成' : '同步完成，但有冲突未处理（见上）');
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`同步失败（未留下部分写入）：${e.message}`);
    process.exit(1);
  }
}
