// 工程闸门共享函数：读取配置与豁免、判定改动范围、计算代码树哈希、读写记录、获取全局锁、读取 PR 状态（gh）。
// 业务含义：闸门要回答三件事——这次改动了哪些文件（范围）、这些文件现在的内容是什么（树哈希）、
// 测试与复审记录是不是针对这份内容、这个基准提交做的（绑定）。范围只有一个口径（gateScope）：
// 配置、豁免表和套件脚本永远在范围内。判定依据不由被审分支决定，在 loadConfig 一处得出：基准分支设置（base）取默认主干上的配置，
// 判定策略字段（POLICY_KEYS：reviewIgnore、reviewFlow、reviewers、reviewMinChars、reviewKeyword、maxReviewRounds）取基准提交上的配置。
// 只读 git 与工作区，写入只发生在 git 目录下的记录目录里，
// 不污染工作区。测试与推送前复审记录放在各工作树自己的 git 目录（互不覆盖）；全局锁与 PR 审查记录（pr 流程）
// 放在 git 公共目录：同一仓库同时只跑一个闸门，PR 的复审与合并可以在不同工作树进行。
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目配置文件（相对仓库根）。同步时创建一次，之后由项目自己维护。 */
export const CONFIG_FILE = 'engineering.config.json';
/** 豁免表（相对仓库根）。每一条都必须写理由，复审时逐条核对。 */
export const EXEMPT_FILE = 'scripts/engineering/exempt.json';

import { normalizeConfig } from './config.mjs';

/** 判断当前脚本是否被直接运行（而不是被测试 import），用于决定是否执行命令行入口。 */
// 入口判断按真实路径比较：Node 的模块地址是真实路径，而命令行里可能经过目录连接（junction/符号链接），
// 只比较字符串会让命令静默不执行（例如 Windows 上安装目录是指向另一个目录的连接）。
export function isMain(importMetaUrl) {
  if (!process.argv[1]) return false;
  const here = fileURLToPath(importMetaUrl);
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(here);
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(here);
  }
}

/** 执行 git，返回 { ok, out, err }，不抛错，由调用方决定如何处理。 */
export function git(root, args) {
  // core.quotepath=off：非 ASCII 文件名（如中文）原样输出，不被加引号转义
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout || '', err: r.stderr || '' };
}

/** 当前目录所在 git 仓库的根目录。 */
export function repoRoot(cwd = process.cwd()) {
  const r = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!r.ok) throw new Error('当前目录不在 git 仓库中');
  return r.out.trim();
}

/** git 公共目录（所有工作树共用）：全局锁放在这里。 */
export function gitCommonDir(root) {
  const r = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!r.ok) throw new Error('无法定位 git 目录');
  return r.out.trim();
}

/**
 * 判定策略字段：决定“这次改动要不要过闸门、怎样才算复审通过”的配置项。它们不能由被审分支自己决定，
 * 生效值取基准提交上的配置（见 loadConfig）。maxReviewRounds 是复审轮次上限（review.mjs 拦截第几轮之后的登记）。
 * 其余字段（testCommand、testEnv、testGroups、sourceGlobs、testGlobs、commentMode、layout、hygiene 等）仍用工作区的值：它们随功能分支一起变化是正常的（新加语言、改测试命令），而且配置文件
 * 永远在闸门范围内，改了就要过测试与复审，会被复审者看到。base 另由默认主干上的配置决定（mainlineBase）。
 */
export const POLICY_KEYS = ['reviewIgnore', 'reviewFlow', 'reviewers', 'reviewMinChars', 'reviewKeyword', 'maxReviewRounds'];

/**
 * 读取某个提交上的项目配置并展开。该提交上没有配置文件时返回 null；读不出或不合法时抛错（失败不放行），
 * 错误信息里写明 label（例如“默认主干 main”“基准提交 1a2b3c”）。
 */
function configAt(root, rev, label) {
  if (!git(root, ['cat-file', '-e', `${rev}:${CONFIG_FILE}`]).ok) return null;
  const r = git(root, ['show', `${rev}:${CONFIG_FILE}`]);
  if (!r.ok) throw new Error(`无法读取${label}上的 ${CONFIG_FILE}：${r.err.trim()}`);
  try {
    return normalizeConfig(JSON.parse(r.out));
  } catch (e) {
    throw new Error(`${label}上的 ${CONFIG_FILE} 无法展开：${e.message}`);
  }
}

/**
 * 读取项目配置（profile 结构或旧版扁平结构）并展开为有效配置；缺失、不是合法 JSON 或结构错误时报错。
 * 闸门的判定依据不由被审分支决定，在这里一处得出，gate、verify、review、merge、hygiene 和钩子拿到的都是同一份生效值：
 *   base           取默认主干上的配置（mainlineBase）；找不到默认主干或主干上没有配置时用工作区的值。
 *   POLICY_KEYS    再用生效的 base 算出基准提交（baseRevision），取该提交上的配置；基准是空树或该提交上没有配置
 *                  （首次安装）时用工作区的值。
 * 主干或基准提交上的配置读不出、不合法时抛错。基准分支解析不了时不在这里抛错（巡检、编辑钩子仍要能用）：
 * 判定策略保持工作区的值并记下 policyError，判定入口（gate、verify、review、merge）调用 assertPolicy 拒绝运行。
 * 返回的配置另带：worktree（工作区里这些字段的原值）、notes（工作区值与生效值不同时的提示行，不算错误）、policyError。
 */
export function loadConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) throw new Error(`缺少 ${CONFIG_FILE}，请先运行同步脚本创建`);
  let user;
  try {
    user = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${CONFIG_FILE} 不是合法 JSON：${e.message}`);
  }
  const config = normalizeConfig(user);
  const worktree = { base: config.base };
  for (const k of POLICY_KEYS) worktree[k] = config[k];
  const notes = [];

  const main = mainlineBase(root);
  const base = main ? main.base : config.base;
  if (base !== config.base) {
    notes.push(`提示：工作区配置的 modules.gate.base 是 ${JSON.stringify(config.base)}，闸门以默认主干 ${main.ref} 上的设置 ${JSON.stringify(base)} 为准；要改基准，须先在主干上改配置`);
  }

  const policy = {};
  let policyError = null;
  let rev = null;
  try {
    rev = baseRevision(root, base).rev;
  } catch (e) {
    policyError = e.message; // 只有基准分支解析不了走这里；基准上的配置不合法时下面的 configAt 直接抛错
  }
  const atBase = rev && rev !== EMPTY_TREE ? configAt(root, rev, `基准提交 ${rev.slice(0, 12)} `) : null;
  if (atBase) {
    for (const k of POLICY_KEYS) policy[k] = atBase[k];
    const differ = POLICY_KEYS.filter((k) => JSON.stringify(atBase[k]) !== JSON.stringify(config[k]));
    if (differ.length > 0) {
      notes.push(`提示：工作区配置的 ${differ.join('、')} 与基准提交 ${rev.slice(0, 12)} 上的不同，闸门按基准上的值判定；这些改动合入主干后才生效`);
    }
  }
  return { ...config, ...policy, base, worktree, notes, policyError };
}

/** 判定入口（gate、verify、review、merge）调用：判定策略没能从基准提交取得（基准分支解析不了）时抛错，不按工作区的值放行。 */
export function assertPolicy(config) {
  if (config.policyError) throw new Error(`无法取得基准提交上的判定策略：${config.policyError}`);
}

/**
 * 默认主干上配置的基准分支设置：按 auto 的规则找到默认主干（origin/HEAD、origin/main、origin/master、main、master），
 * 读取该提交上的项目配置的 base。返回 { ref, base }；找不到默认主干（空仓库、首次提交前）或该提交上没有配置文件时返回 null
 * （由调用方用工作区的值）。默认主干上的配置读不出或不合法时抛错（失败不放行）。
 * 业务含义：分支把 base 改成指向自己，改动就成了空的，闸门会直接放行；所以基准设置只认主干上的。
 */
export function mainlineBase(root) {
  const ref = AUTO_BASE_CANDIDATES.find((c) => git(root, ['rev-parse', '--verify', '--quiet', `${c}^{commit}`]).ok);
  if (!ref) return null;
  const cfg = configAt(root, ref, `默认主干 ${ref} `);
  return cfg ? { ref, base: cfg.base } : null;
}

/**
 * 读取豁免表；没有则为空。豁免只放行被列出的路径，不影响其他文件。各段：testFirst（测试先行）、comments（注释）、
 * newFiles（新文件位置）、assertions（测试文件里没有断言痕迹，例如只验证能导入的冒烟测试）。
 */
export function loadExempt(root) {
  const file = path.join(root, EXEMPT_FILE);
  if (!fs.existsSync(file)) return { testFirst: {}, comments: {}, newFiles: {}, assertions: {} };
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { testFirst: j.testFirst || {}, comments: j.comments || {}, newFiles: j.newFiles || {}, assertions: j.assertions || {} };
}

/** 路径（斜杠分隔）是否匹配任一 glob。 */
export function matchesAny(rel, globs) {
  return globs.some((g) => path.matchesGlob(rel, g));
}

/** 是否属于需要测试先行与注释检查的源文件（测试文件本身不算源文件）。 */
export function isSourceFile(rel, config) {
  return matchesAny(rel, config.sourceGlobs) && !matchesAny(rel, config.testGlobs);
}

/** 是否属于测试文件。 */
export function isTestFile(rel, config) {
  return matchesAny(rel, config.testGlobs);
}

/** 把 git 输出的多行路径变成去重、排序的数组（统一为斜杠）。 */
function pathLines(text) {
  return text
    .split('\n')
    .map((s) => s.trim().replace(/\\/g, '/'))
    .filter(Boolean);
}

/**
 * 本次改动的全部文件（相对仓库根）：
 * 已提交但未合入 base 的差异 + 工作区与暂存区相对 HEAD 的改动 + 未跟踪且未忽略的文件。
 * 删除的文件也算改动（会改变树哈希）。
 */
export function changedFiles(root, base) {
  // 基准分支解析不了时必须报错：若静默返回空列表，已提交的功能分支会被判定为“没有改动”而放行（失败放行）。
  return changedSince(root, baseRevision(root, base).rev);
}

/**
 * 套件里所有“改动了哪些文件”都经这里取：git diff --no-renames --name-only <args>。返回 { ok, files, err }（files 为斜杠路径）。
 * 业务含义：git 默认开启改名检测，改名只列出新路径，旧路径从改动列表里消失——代码 git mv 进 docs/ 就像“只改了文档”，
 * 文件从一个测试分组改名到另一个分组时旧分组不跑。固定 --no-renames，改名一律表现为“旧路径删除 + 新路径新增”。
 */
export function diffNames(root, args) {
  const r = git(root, ['diff', '--no-renames', '--name-only', ...args]);
  return { ok: r.ok, files: r.ok ? pathLines(r.out) : [], err: r.err };
}

/** 相对给定基准提交（或空树）的全部改动，口径同 changedFiles。改名按旧路径删除加新路径新增计（diffNames）。 */
function changedSince(root, rev) {
  const set = new Set();
  if (git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).ok) {
    for (const f of diffNames(root, [rev, 'HEAD']).files) set.add(f);
    for (const f of diffNames(root, ['HEAD']).files) set.add(f);
  }
  for (const f of pathLines(git(root, ['ls-files', '--others', '--exclude-standard']).out)) set.add(f);
  return [...set].sort();
}

/**
 * 本次新增的文件：未跟踪的文件，加上相对基准提交新增的文件。diffNames 不做改名检测，改名后的新路径自然算新增
 * （否则 git mv 进不允许的位置就绕过了位置检查）。比较的是基准提交与工作区，已提交、已暂存的都算。
 */
export function newFiles(root, base) {
  const out = new Set(pathLines(git(root, ['ls-files', '--others', '--exclude-standard']).out));
  if (git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).ok) {
    const { rev } = baseRevision(root, base);
    const r = diffNames(root, ['--diff-filter=A', rev]);
    if (!r.ok) throw new Error(`无法读取新增文件（git diff 失败）：${r.err.trim()}`);
    for (const f of r.files) out.add(f);
  }
  return [...out].sort();
}

/** 仓库里所有已跟踪与未跟踪（未忽略）的文件，用于判断“是否已有源码或测试”。 */
export function repoFiles(root) {
  return pathLines(git(root, ['ls-files', '--cached', '--others', '--exclude-standard']).out);
}

/**
 * 基准提交：配置的基准分支与 HEAD 的 merge-base（首次提交前为空树）。返回 { rev }，rev 是 changedFiles 实际用来做 diff 的修订，
 * 测试与复审记录写入它（基线）；解析不了时抛错（失败不放行）。
 */
export function baseRevision(root, base) {
  const resolved = resolveBase(root, base);
  if (resolved === EMPTY_TREE) return { rev: EMPTY_TREE };
  const mb = git(root, ['merge-base', resolved, 'HEAD']);
  if (!mb.ok) throw new Error(`无法解析基准分支 ${resolved}（请先 git fetch，或在 engineering.config.json 的 base 里写正确的分支）`);
  return { rev: mb.out.trim() };
}

/** git 的空树对象（所有仓库都有）：首次提交前没有任何基准提交时，用它当作基线。 */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** 自动识别基准分支时依次尝试的候选（远程默认分支优先，其次本地主干）。 */
const AUTO_BASE_CANDIDATES = ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master'];

/**
 * 把配置里的 base 解析为一个可比较的修订。
 * base 为 auto：依次取第一个存在的候选；都不存在但仓库还没有任何提交时，返回空树（首次提交前的全部文件都算改动）；
 *   其余情况报错（失败不放行）。
 * base 为明确的分支名：原样返回，解析失败由 baseRevision 报错。
 */
export function resolveBase(root, base) {
  if (base !== 'auto') return base;
  for (const c of AUTO_BASE_CANDIDATES) {
    if (git(root, ['rev-parse', '--verify', '--quiet', `${c}^{commit}`]).ok) return c;
  }
  if (!git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).ok) return EMPTY_TREE;
  throw new Error('无法自动识别基准分支（试过 origin/HEAD、origin/main、origin/master、main、master），请在 engineering.config.json 的 modules.gate.base 写明');
}

/**
 * 范围内未提交（已修改、已暂存、未跟踪或已删除）的文件。
 * 不把范围作为 pathspec 传给 git（文件多时会超过命令行长度，路径里的 [ * 等会被当作通配符）；
 * 而是读全部状态，再在本地按范围过滤。git 失败时抛错，绝不返回空列表（失败不放行）。
 */
export function uncommittedInScope(root, scope) {
  const r = git(root, ['status', '--porcelain', '-uall', '-z']);
  if (!r.ok) throw new Error(`无法读取工作区状态（git status 失败）：${r.err.trim()}`);
  const inScope = new Set(scope);
  return parseStatusZ(r.out).filter((e) => inScope.has(e.file)).map((e) => e.file);
}

/**
 * 解析 `git status --porcelain -z` 的输出：返回 [{ code, file }]（斜杠路径）。
 * -z 下路径不加引号（带空格、中文的路径原样输出）；改名条目后面多跟一个字段（旧路径），这里跳过它。
 */
export function parseStatusZ(text) {
  const out = [];
  const parts = text.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    const code = p.slice(0, 2);
    out.push({ code, file: p.slice(3).replace(/\\/g, '/') });
    if (code.includes('R') || code.includes('C')) i++;
  }
  return out;
}

/** glob 里字面的顶层目录名（例如以 tests 开头的 glob 得到 tests；含通配符的段不算）。 */
export function literalTopDirs(globs) {
  return globs.map((g) => g.split('/')[0]).filter((s) => s && !/[*?{[]/.test(s));
}

/**
 * 允许的顶层目录：白名单加上源码、测试 glob 推出的字面目录（如以 test/ 开头的测试 glob 得到 test），
 * 巡检与推送核对共用，避免两处算法不一致。
 */
export function allowedTopDirs(layout) {
  return new Set([...layout.topLevelAllowed, ...literalTopDirs([...layout.sourceGlobs, ...layout.testGlobs])]);
}

/**
 * 永远计入闸门范围的路径（glob）：项目配置、豁免表和装进项目的套件脚本。它们决定闸门怎么判，
 * 改它们等于改闸门本身，所以不受 reviewIgnore 影响（否则分支把 reviewIgnore 改成 ** 就能让范围变空）。
 */
export const ALWAYS_IN_SCOPE = [CONFIG_FILE, EXEMPT_FILE, 'scripts/engineering/**'];

/**
 * 依赖清单与锁文件（glob，根目录和子目录都匹配）：它们一变，任何测试的结果都可能变，按影响范围测试时一律改跑全量。
 * 局限：只列常见语言的包管理文件；项目自定义的依赖脚本不在其中，不要把它放进任何测试分组，让它的改动触发全量。
 */
export const DEPENDENCY_FILES = [
  '**/package.json', '**/package-lock.json', '**/npm-shrinkwrap.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/pnpm-workspace.yaml',
  '**/bun.lock', '**/bun.lockb', '**/deno.json', '**/deno.lock',
  '**/requirements*.txt', '**/constraints*.txt', '**/pyproject.toml', '**/poetry.lock', '**/uv.lock', '**/Pipfile', '**/Pipfile.lock',
  '**/setup.py', '**/setup.cfg', '**/go.mod', '**/go.sum', '**/go.work', '**/Cargo.toml', '**/Cargo.lock',
  '**/Gemfile', '**/Gemfile.lock', '**/composer.json', '**/composer.lock', '**/pom.xml', '**/build.gradle', '**/build.gradle.kts',
  '**/gradle.lockfile', '**/*.csproj', '**/packages.lock.json', '**/Package.swift', '**/Package.resolved',
];

/** 是否算文档（不计入闸门范围）：匹配给定的 reviewIgnore，且不是永远在范围内的文件。 */
export function isIgnoredDoc(rel, reviewIgnore) {
  return !matchesAny(rel, ALWAYS_IN_SCOPE) && matchesAny(rel, reviewIgnore);
}

/**
 * 闸门范围（gate、verify、review 三处共用的唯一口径）。config 必须来自 loadConfig（其中的 base 与 reviewIgnore 已是生效值）。返回：
 *   baseRev      基准提交（changedFiles 做 diff 用的那个），写进记录作为基线
 *   changed      本次全部改动
 *   reviewIgnore 判定用的 reviewIgnore（基准提交上的配置版本，由 loadConfig 得出）
 *   scope        闸门范围：changed 去掉文档（isIgnoredDoc）的部分，参与树哈希绑定
 *   docs         changed 里的文档部分
 * 工作区配置的其他字段（测试命令、glob 等）照常由调用方使用。
 */
export function gateScope(root, config) {
  assertPolicy(config);
  const { rev } = baseRevision(root, config.base);
  const changed = changedSince(root, rev);
  const { reviewIgnore } = config;
  const scope = changed.filter((f) => !isIgnoredDoc(f, reviewIgnore));
  const docs = changed.filter((f) => isIgnoredDoc(f, reviewIgnore));
  return { baseRev: rev, changed, reviewIgnore, scope, docs };
}

/** 参与闸门记录绑定的文件：gateScope 的 scope（纯文档改动不使记录失效）。 */
export function scopeFiles(root, config) {
  return gateScope(root, config).scope;
}

/**
 * 当前检出的位置：{ branch, headSha }。游离 HEAD 时 branch 为 null；仓库还没有任何提交时 headSha 为 null。
 * 复审登记用它写明“这次登记对应哪个分支的哪个提交”。
 */
export function headInfo(root) {
  const branch = git(root, ['branch', '--show-current']).out.trim() || null;
  const head = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  return { branch, headSha: head.ok ? head.out.trim() : null };
}

/**
 * 子模块（gitlink）当前指向的提交：已检出的子模块取它自己的 HEAD（工作区里实际用的那份），
 * 未检出的取索引里记录的提交；都不是时返回 null。
 */
function gitlinkCommit(root, rel, indexLinks) {
  const dir = path.join(root, rel);
  if (fs.existsSync(path.join(dir, '.git'))) {
    const r = git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    if (r.ok) return r.out.trim();
  }
  return indexLinks.get(rel) ?? null;
}

/** 索引里的全部 gitlink（模式 160000）：路径 → 提交号。 */
function indexGitlinks(root) {
  const out = new Map();
  for (const entry of git(root, ['ls-files', '--stage', '-z']).out.split('\0')) {
    const m = /^160000 ([0-9a-f]+) \d+\t(.+)$/.exec(entry);
    if (m) out.set(m[2].replace(/\\/g, '/'), m[1]);
  }
  return out;
}

/**
 * 每个文件的内容摘要：路径 → git 对象名（与 git add 相同的清洗过滤器）；子模块记为 gitlink:<提交号>，文件不存在（已删除）记为 deleted。
 * 测试记录保存它（files），以后按影响范围测试时与当前内容逐个比较，算出此后改了哪些文件。
 */
export function fileHashes(root, files) {
  const sorted = [...new Set(files)].sort();
  const dirs = [];
  const present = sorted.filter((f) => {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) return false;
    if (fs.statSync(p).isDirectory()) dirs.push(f);
    return fs.statSync(p).isFile();
  });
  // 改动列表里的目录只可能是子模块：按指向的提交号计入，不当作已删除（否则子模块指针变化不改变哈希）
  const links = new Map();
  if (dirs.length > 0) {
    const indexLinks = indexGitlinks(root);
    for (const d of dirs) {
      const sha = gitlinkCommit(root, d, indexLinks);
      if (sha) links.set(d, `gitlink:${sha}`);
    }
  }
  // 内容哈希交给 git hash-object（与 git add 相同的清洗过滤器）：Windows 的 core.autocrlf 会在 checkout 时
  // 把 LF 改成 CRLF，直接读字节会让同一份提交的哈希变化，从而误判“代码变了”。
  const hashes = new Map();
  if (present.length > 0) {
    const r = spawnSync('git', ['-C', root, 'hash-object', '--stdin-paths'], { input: `${present.join('\n')}\n`, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`计算代码树哈希失败：${r.stderr}`);
    const out = r.stdout.split('\n').filter(Boolean);
    present.forEach((f, i) => hashes.set(f, out[i]));
  }
  const out = {};
  for (const f of sorted) out[f] = hashes.get(f) ?? links.get(f) ?? 'deleted';
  return out;
}

/** 由 fileHashes 的结果算代码树哈希：对每个文件的路径与内容摘要排序后再取摘要。 */
export function hashOfFiles(map) {
  const h = crypto.createHash('sha256');
  for (const f of Object.keys(map).sort()) h.update(`${f}\t${map[f]}\n`);
  return h.digest('hex');
}

/**
 * 代码树哈希：对每个文件的路径与内容摘要排序后再取摘要。
 * 子模块（gitlink）按它指向的提交号计入；文件不存在（已删除）记为 deleted。只看这些文件的当前内容，与是否提交无关。
 */
export function treeHash(root, files) {
  return hashOfFiles(fileHashes(root, files));
}

/** 记录目录：当前工作树自己的 git 目录下的 engineering-gate/（多个工作树各用各的，不互相覆盖）。 */
export function recordDir(root) {
  const r = git(root, ['rev-parse', '--path-format=absolute', '--git-dir']);
  if (!r.ok) throw new Error('无法定位 git 目录');
  return path.join(r.out.trim(), 'engineering-gate');
}

/** 写入一条记录（JSON）。 */
export function writeRecord(root, name, obj) {
  const d = recordDir(root);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, name), `${JSON.stringify(obj, null, 2)}\n`);
}

/** 读取一条记录；不存在或损坏返回 null（视为未记录）。 */
export function readRecord(root, name) {
  const f = path.join(recordDir(root), name);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

/** 锁的持有进程是否确定已不存在（读不到 pid 或无权探测时返回 false，保守视为仍在）。 */
function ownerGone(ownerJson) {
  try {
    process.kill(JSON.parse(ownerJson).pid, 0);
    return false;
  } catch (e) {
    return e.code === 'ESRCH';
  }
}

/**
 * 获取全局闸门锁（同一 git 公共目录同时只允许一个闸门运行，避免并行会话把内存耗尽或互相清库）。
 * 超过 maxAgeMinutes 的残留锁视为失效并清掉。返回释放函数，必须在 finally 中调用。
 */
export function acquireLock(root, maxAgeMinutes = 90) {
  const dir = path.join(gitCommonDir(root), 'engineering-gate.lock');
  const maxAgeMs = maxAgeMinutes * 60 * 1000;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), root }));
      return () => fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner = '';
      try {
        owner = fs.readFileSync(path.join(dir, 'owner.json'), 'utf8');
      } catch {
        owner = '';
      }
      // 持锁进程已不在（如闸门被 Ctrl+C）：清锁重试；读不到 pid 时只按时间判断
      if (Date.now() - fs.statSync(dir).mtimeMs > maxAgeMs || ownerGone(owner)) {
        fs.rmSync(dir, { recursive: true, force: true });
        continue;
      }
      throw new Error(`闸门锁被占用（同一仓库同时只能跑一个闸门）：${owner.trim() || dir}`);
    }
  }
  throw new Error('无法获取闸门锁');
}

/** 默认的 gh 调用：在仓库根运行 gh，返回 spawnSync 的结果。登记与合并都接受注入的实现，测试用假的 gh，不访问网络。 */
export function defaultGh(args, cwd) {
  return spawnSync('gh', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** 运行 gh 并返回标准输出；gh 不存在或返回非 0 时抛错（失败不放行）。 */
export function runGh(gh, args, root) {
  const r = gh(args, root);
  if (!r || r.error || r.status !== 0) {
    const why = r?.error ? r.error.message : (r?.stderr || '').trim() || `退出码 ${r?.status}`;
    throw new Error(`gh ${args.slice(0, 2).join(' ')} 失败：${why}`);
  }
  return r.stdout || '';
}

/** 校验 PR 编号：只允许正整数（它会成为记录目录名，不能带路径字符）。返回字符串形式。 */
export function prNumber(pr) {
  if (!/^[1-9]\d*$/.test(String(pr ?? ''))) throw new Error(`PR 编号不合法：${pr}（应为正整数）`);
  return String(pr);
}

/** 视为通过的检查结论：成功、跳过、中性。 */
const CI_OK = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);

/**
 * CI 是否全部通过：每一项检查都是成功、跳过或中性；一项检查都没有视为未通过。返回未通过的原因（空数组表示全过）。
 * 检查运行（CheckRun）看 conclusion，未完成时为空；提交状态（StatusContext）看 state。
 */
export function ciProblems(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return ['PR 上没有任何 CI 检查（视为未通过；没有 CI 的项目应使用 pre-push 流程）'];
  return checks
    .filter((c) => !CI_OK.has(String(c.conclusion || c.state || '').toUpperCase()))
    .map((c) => `CI 检查未通过：${c.name || c.context || '（未命名）'}（${c.conclusion || c.state || c.status || '运行中'}）`);
}

/**
 * 读取 PR 的状态、最终提交与 CI 结果（gh pr view；statusCheckRollup 是最终提交上的检查）。
 * 返回 { state, head, ciProblems, files }（files 是 PR 改动的文件路径，gh 最多返回 100 个）；gh 失败或输出不合法时抛错。
 */
export function readPr(root, pr, gh) {
  const out = runGh(gh, ['pr', 'view', pr, '--json', 'state,headRefOid,statusCheckRollup,files'], root);
  let j;
  try {
    j = JSON.parse(out);
  } catch (e) {
    throw new Error(`gh pr view 的输出不是合法 JSON：${e.message}`);
  }
  if (!j || !j.headRefOid) throw new Error('gh pr view 的输出缺少最终提交（headRefOid）');
  const files = Array.isArray(j.files) ? j.files.map((f) => f.path) : [];
  return { state: j.state, head: j.headRefOid, ciProblems: ciProblems(j.statusCheckRollup), files };
}

/** PR 审查历史：git 公共目录下 engineering-gate/pr/<编号>/log.jsonl，每次登记（pass、fail、defer、accept）追加一行，复审轮次按它计数。 */
export function prLogFile(root, pr) {
  return path.join(gitCommonDir(root), 'engineering-gate', 'pr', pr, 'log.jsonl');
}

/** PR 审查记录文件：git 公共目录下 engineering-gate/pr/<编号>/<kind>.json（复审与合并可能在不同工作树进行，所以不放 recordDir）。 */
export function prRecordFile(root, pr, kind) {
  return path.join(gitCommonDir(root), 'engineering-gate', 'pr', pr, `${kind}.json`);
}
