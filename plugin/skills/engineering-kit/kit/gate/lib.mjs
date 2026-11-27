// 工程闸门共享函数：读取配置与豁免、判定改动范围、计算代码树哈希、读写记录、获取全局锁、读取 PR 状态（gh）。
// 业务含义：闸门要回答三件事——这次改动了哪些文件（范围）、这些文件现在的内容是什么（树哈希）、
// 测试与复审记录是不是针对这份内容、这个基准提交做的（绑定）。范围只有一个口径（gateScope）：
// 配置、豁免表和套件脚本永远在范围内。判定依据不由被审分支决定，在 loadConfig 一处得出：基准分支设置（base）取默认主干上的配置，
// 判定策略字段（含复审轮次、收口方式和风险登记路径，见 POLICY_KEYS）取基准提交上的配置。
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

import { DEFAULTS, normalizeConfig } from './config.mjs';

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
 * externalExecutors 是允许的外部复审执行器（external-review.mjs）；externalExclude 是外发前追加排除的 glob，
 * external-review.mjs 另取它与工作区值的并集（排除只会让外发变少，分支新加的排除当轮就生效）。
 * 其余字段（testCommand、testEnv、testGroups、sourceGlobs、testGlobs、commentMode、layout、hygiene 等）仍用工作区的值：它们随功能分支一起变化是正常的（新加语言、改测试命令），而且配置文件
 * 永远在闸门范围内，改了就要过测试与复审，会被复审者看到。base 另由默认主干上的配置决定（mainlineBase）。
 */
export const POLICY_KEYS = ['reviewIgnore', 'reviewFlow', 'requiredChecks', 'reviewers', 'reviewMinChars', 'reviewSections', 'reviewKeyword', 'maxReviewRounds', 'roundClosure', 'riskRegister', 'externalExecutors', 'externalExclude', 'fullTests', 'ciRunner'];

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
 * 返回的配置另带：worktree（工作区里这些字段的原值）、notes（工作区值与生效值不同时的提示行，不算错误）、policyError、
 * baseRev（判定时用的基准提交号；解析不了时为 null，首次提交前是空树）——调用方要引用基准提交时用它，不要自己再解析一次。
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
    // externalExclude 由 external-review.mjs 与工作区取并集、当轮生效，不适用“合入主干后才生效”的提示
    const differ = POLICY_KEYS.filter((k) => k !== 'externalExclude' && JSON.stringify(atBase[k]) !== JSON.stringify(config[k]));
    if (differ.length > 0) {
      notes.push(`提示：工作区配置的 ${differ.join('、')} 与基准提交 ${rev.slice(0, 12)} 上的不同，闸门按基准上的值判定；这些改动合入主干后才生效`);
    }
  }
  return { ...config, ...policy, base, worktree, notes, policyError, baseRev: rev };
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
 * 暂存的改名（R）旧路径也算：提交里的旧路径还是改名前的内容，工作区里它已“删除”，不算上它，
 * 把源文件只暂存 git mv 进 docs/ 就能让推送核对看不出 HEAD 里有未经测试和复审的代码。复制（C）的来源文件没有变，不算。
 */
export function uncommittedInScope(root, scope) {
  const r = git(root, ['status', '--porcelain', '-uall', '-z']);
  if (!r.ok) throw new Error(`无法读取工作区状态（git status 失败）：${r.err.trim()}`);
  const inScope = new Set(scope);
  const files = parseStatusZ(r.out).filter((e) => !(e.from && e.code.includes('C') && !e.code.includes('R'))).map((e) => e.file);
  return [...new Set(files.filter((f) => inScope.has(f)))];
}

/**
 * 解析 `git status --porcelain -z` 的输出：返回 [{ code, file, from? }]（斜杠路径）。
 * -z 下路径不加引号（带空格、中文的路径原样输出）。改名（R）、复制（C）条目后面多跟一个字段（旧路径或来源），
 * 它也作为一项返回，带 from: true、code 与新路径相同：调用方据此决定是否计入（改名的旧路径是一处改动，不能丢）。
 * 不靠 git status --no-renames：解析两种输出都对，不依赖 git 的版本和 status.renames 配置。
 */
export function parseStatusZ(text) {
  const out = [];
  const parts = text.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    const code = p.slice(0, 2);
    out.push({ code, file: p.slice(3).replace(/\\/g, '/') });
    if ((code.includes('R') || code.includes('C')) && parts[i + 1]) {
      i++;
      out.push({ code, file: parts[i].replace(/\\/g, '/'), from: true });
    }
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
export function isIgnoredDoc(rel, reviewIgnore, riskRegister = DEFAULTS.riskRegister) {
  return rel !== riskRegister && !matchesAny(rel, ALWAYS_IN_SCOPE) && matchesAny(rel, reviewIgnore);
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
  const scope = changed.filter((f) => !isIgnoredDoc(f, reviewIgnore, config.riskRegister));
  const docs = changed.filter((f) => isIgnoredDoc(f, reviewIgnore, config.riskRegister));
  return { baseRev: rev, changed, reviewIgnore, scope, docs };
}

/**
 * 某个提交上的闸门范围：与 gateScope 同一口径（基准提交同为 baseRevision），只是改动取基准提交到该提交的差异，不看工作区。
 * 给了被审范围的复审登记用它：绑定的内容来自不可变的提交，与工作区在两次读取之间的变化无关。读不出差异时抛错。
 */
export function gateScopeAt(root, config, commit) {
  assertPolicy(config);
  const { rev } = baseRevision(root, config.base);
  const r = diffNames(root, [rev, commit]);
  if (!r.ok) throw new Error(`无法读取基准提交到 ${String(commit).slice(0, 12)} 的差异：${r.err.trim()}`);
  const { reviewIgnore } = config;
  const changed = r.files;
  const scope = changed.filter((f) => !isIgnoredDoc(f, reviewIgnore, config.riskRegister));
  const docs = changed.filter((f) => isIgnoredDoc(f, reviewIgnore, config.riskRegister));
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
function gitlinkCommit(root, rel, indexEntries) {
  const dir = path.join(root, rel);
  if (fs.existsSync(path.join(dir, '.git'))) {
    const r = git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    if (r.ok) return r.out.trim();
  }
  const e = indexEntries.get(rel);
  return e && e.mode === '160000' ? e.sha : null;
}

/** 索引里的全部条目：路径 → { mode, sha }。 */
function indexEntries(root) {
  const out = new Map();
  for (const entry of git(root, ['ls-files', '--stage', '-z']).out.split('\0')) {
    const m = /^(\d+) ([0-9a-f]+) \d+\t(.+)$/s.exec(entry);
    if (m) out.set(m[3].replace(/\\/g, '/'), { mode: m[1], sha: m[2] });
  }
  return out;
}

/**
 * 一个文件的摘要写法（工作区与提交共用，见 fileHashes、treeHashAt）：普通文件（100644）只写对象名，与旧版相同；
 * 可执行文件和符号链接在前面加上模式（100755:、120000:），子模块写 gitlink:<提交号>。可执行位、符号链接会改变运行结果，
 * 只比内容会把它们当成同一份代码。
 */
function entryDigest(mode, sha) {
  if (mode === '160000') return `gitlink:${sha}`;
  return mode === '100644' ? sha : `${mode}:${sha}`;
}

/**
 * 每个文件的内容摘要：路径 → 摘要（entryDigest；对象名与 git add 相同：经清洗过滤器）；文件不存在（已删除）记为 deleted。
 * 模式按 git 自己的看法取，两项配置各管各的：工作区里的真符号链接一律按链接（120000，摘要取链接文本）；
 * core.symlinks 关着（Windows 默认）时，索引里是 120000 的条目检出为内容是链接文本的普通文件，仍按链接计；
 * 其余普通文件看 core.fileMode：开着（POSIX 默认）时按可执行位取 100755 或 100644，关着（Windows 默认）时 git 不看可执行位，取索引里的 100755 或 100644。
 * 测试记录保存它（files），以后按影响范围测试时与当前内容逐个比较，算出此后改了哪些文件。
 */
export function fileHashes(root, files) {
  const sorted = [...new Set(files)].sort();
  const dirs = [];
  const links = [];
  const stats = new Map();
  const present = sorted.filter((f) => {
    const st = fs.lstatSync(path.join(root, f), { throwIfNoEntry: false });
    if (!st) return false;
    stats.set(f, st);
    if (st.isSymbolicLink()) { links.push(f); return false; }
    if (st.isDirectory()) dirs.push(f);
    return st.isFile();
  });
  const index = sorted.length > 0 ? indexEntries(root) : new Map();
  const fileMode = git(root, ['config', '--bool', 'core.fileMode']).out.trim() !== 'false';
  const symlinks = git(root, ['config', '--bool', 'core.symlinks']).out.trim() !== 'false';
  const out = {};
  // 改动列表里的目录只可能是子模块：按指向的提交号计入，不当作已删除（否则子模块指针变化不改变哈希）
  for (const d of dirs) {
    const sha = gitlinkCommit(root, d, index);
    if (sha) out[d] = entryDigest('160000', sha);
  }
  // 内容哈希交给 git hash-object（与 git add 相同的清洗过滤器）：Windows 的 core.autocrlf 会在 checkout 时
  // 把 LF 改成 CRLF，直接读字节会让同一份提交的哈希变化，从而误判“代码变了”。
  if (present.length > 0) {
    const r = spawnSync('git', ['-C', root, 'hash-object', '--stdin-paths'], { input: `${present.join('\n')}\n`, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`计算代码树哈希失败：${r.stderr}`);
    const shas = r.stdout.split('\n').filter(Boolean);
    present.forEach((f, i) => {
      const indexed = index.get(f)?.mode;
      let mode;
      if (!symlinks && indexed === '120000') mode = '120000';
      else if (fileMode) mode = stats.get(f).mode & 0o100 ? '100755' : '100644';
      else mode = indexed === '100755' ? '100755' : '100644';
      out[f] = entryDigest(mode, shas[i]);
    });
  }
  for (const f of links) {
    const r = spawnSync('git', ['-C', root, 'hash-object', '--stdin'], { input: fs.readlinkSync(path.join(root, f)), encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`计算符号链接 ${f} 的摘要失败：${r.stderr}`);
    out[f] = entryDigest('120000', r.stdout.trim());
  }
  const sortedOut = {};
  for (const f of sorted) sortedOut[f] = out[f] ?? 'deleted';
  return sortedOut;
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

/**
 * 某个提交里这些文件的代码树哈希，口径同 treeHash：提交里的对象名就是 git add 清洗后的内容摘要（与 hash-object 相同），
 * 每个文件按 entryDigest 写（模式取树里记录的），提交里没有的记 deleted。所以干净工作区上两者相等。读不出提交的树时抛错。
 */
export function treeHashAt(root, rev, files) {
  const r = git(root, ['ls-tree', '-r', '-z', '--full-tree', rev]);
  if (!r.ok) throw new Error(`无法读取提交 ${String(rev).slice(0, 12)} 的树：${r.err.trim()}`);
  const entries = new Map();
  for (const row of r.out.split('\0')) {
    const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/s.exec(row);
    if (m) entries.set(m[4], entryDigest(m[1], m[3]));
  }
  const out = {};
  for (const f of [...new Set(files)].sort()) out[f] = entries.get(f) ?? 'deleted';
  return hashOfFiles(out);
}

/** 某个提交上的项目配置（展开后）；该提交上没有配置文件时返回 null，不合法时抛错。 */
export function configAtRev(root, rev) {
  return configAt(root, rev, `提交 ${String(rev).slice(0, 12)} `);
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

/** 非必需检查另外放行的结论：跳过、中性。必需检查只认成功（SUCCESS）。 */
const CI_SOFT_OK = new Set(['SKIPPED', 'NEUTRAL']);

/**
 * 一项检查的显示名、所属工作流与结论：检查运行（CheckRun）看 name、workflowName 与 conclusion（未完成时为空），
 * 提交状态（StatusContext）看 context 与 state（没有工作流，记为空串）；kind 是 gh 给的 __typename（CheckRun 或 StatusContext，没有时为空串）。
 * 通过 Checks API 上报的第三方检查运行（如 CodeRabbit、codecov/patch），gh 给的 workflowName 也是空串（2026-11 在公开仓库的 PR 上核对过），
 * 所以分组还要带上 kind，不与同名的提交状态混成一组；两个第三方应用上报的同名检查运行仍分不开（gh 不给来源应用），属“只按名字比对”的局限。
 */
function checkInfo(c) {
  return { name: c.name || c.context || '（未命名）', workflow: c.workflowName || '', kind: c.__typename || '', result: String(c.conclusion || c.state || '').toUpperCase(), shown: c.conclusion || c.state || c.status || '运行中' };
}

/**
 * CI 结果分类。requiredChecks 是必需检查名（modules.gate.requiredChecks，取基准提交上的配置），按检查运行的 name（job 名，含矩阵后缀，
 * 不含工作流名和事件）或提交状态的 context 比对，与 GitHub 分支保护里必需检查的写法相同；为空时 PR 上报告的每一项都算必需。
 * 同一工作流里同名的检查合在一起判定（同一个 job 可能因 push 与 pull_request 各跑一份，一份成功、一份跳过）：同组各份里有失败、取消、
 * 运行中等结论就不通过；至少一份成功、其余只有跳过或中性的算成功；全是跳过或中性的，必需检查不通过，非必需检查放行。
 * 不同工作流里的同名检查各算一组，不互相抵：必需检查名出现在几个工作流里，每一组都要满足。
 * 列出的必需检查在 PR 上一项都找不到（没有运行或改了名）按未通过，提示里列出本次看到的检查名，便于改正配置。一项检查都没有视为未通过。
 * 返回 { problems, passed, skipped }：problems 是未通过的原因（空数组表示通过），passed 是成功的检查（{ name, label, required }），
 * skipped 是被放行的跳过或中性的非必需检查（{ name, label, result }），供合并入口分开报告；name 是检查名（与必需检查名同一写法），
 * label 是报告里的显示名：同名的检查分在几组时带上工作流名或种类，便于分辨，否则与 name 相同。
 */
export function ciStatus(checks, requiredChecks = []) {
  if (!Array.isArray(checks) || checks.length === 0) {
    return { problems: ['PR 上没有任何 CI 检查（视为未通过；没有 CI 的项目应使用 pre-push 流程）'], passed: [], skipped: [] };
  }
  const listed = requiredChecks.length > 0;
  const groups = new Map(); // 种类、工作流名加检查名 → 同组的各份检查，保持首次出现的顺序
  for (const c of checks) {
    const info = checkInfo(c);
    const key = `${info.kind}\u0000${info.workflow}\u0000${info.name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(info);
  }
  // 同名的检查分在几组时（不同工作流，或检查运行与提交状态），报告里的显示名要能分开：加上工作流名，没有工作流名的加上种类，否则会打印“test、test”
  const groupsByName = new Map();
  for (const runs of groups.values()) groupsByName.set(runs[0].name, (groupsByName.get(runs[0].name) ?? 0) + 1);
  const labelOf = ({ name, workflow, kind }) => (groupsByName.get(name) > 1 ? `${workflow ? `${workflow} / ` : ''}${name}${workflow || !kind ? '' : `（${kind}）`}` : name);
  const problems = [];
  const passed = [];
  const skipped = [];
  for (const runs of groups.values()) {
    const { name } = runs[0];
    const label = labelOf(runs[0]);
    const required = !listed || requiredChecks.includes(name);
    const bad = runs.filter((r) => r.result !== 'SUCCESS' && !CI_SOFT_OK.has(r.result));
    if (bad.length > 0) {
      for (const r of bad) problems.push(`CI 检查未通过：${label}（${r.shown}）`);
    } else if (runs.some((r) => r.result === 'SUCCESS')) {
      passed.push({ name, label, required });
    } else if (required) {
      problems.push(`必需检查没有成功：${label}（${runs.map((r) => r.shown).join('、')}；必需检查须为成功，跳过、中性只放行非必需检查${listed ? '' : '。未配置 modules.gate.requiredChecks 时每一项检查都算必需'}）`);
    } else {
      skipped.push({ name, label, result: [...new Set(runs.map((r) => r.result))].join('、') });
    }
  }
  const names = [...new Set(checks.map((c) => checkInfo(c).name))];
  const seen = names.join('、');
  for (const n of requiredChecks) {
    if (!names.includes(n)) problems.push(`必需检查没有出现在 PR 上：${n}（没有运行，或检查改了名；按检查运行的 job 名或提交状态的 context 比对，本次 PR 上的检查名：${seen}）`);
  }
  return { problems, passed, skipped };
}

/**
 * 读取 PR 的状态、最终提交与 CI 结果（gh pr view；statusCheckRollup 是最终提交上的检查）。
 * requiredChecks 是生效的必需检查名（见 ciStatus）。返回 { state, head, ciProblems, ci }（ci 是 ciStatus 的完整结果）；gh 失败或输出不合法时抛错。不取 PR 的文件列表：改名时它可能只给新路径，且最多 100 个，“只改文档”由 merge.mjs 按本地差异判定。
 */
export function readPr(root, pr, gh, requiredChecks = []) {
  const out = runGh(gh, ['pr', 'view', pr, '--json', 'state,headRefOid,statusCheckRollup'], root);
  let j;
  try {
    j = JSON.parse(out);
  } catch (e) {
    throw new Error(`gh pr view 的输出不是合法 JSON：${e.message}`);
  }
  if (!j || !j.headRefOid) throw new Error('gh pr view 的输出缺少最终提交（headRefOid）');
  const ci = ciStatus(j.statusCheckRollup, requiredChecks);
  return { state: j.state, head: j.headRefOid, ciProblems: ci.problems, ci };
}

/** PR 审查历史：git 公共目录下 engineering-gate/pr/<编号>/log.jsonl，每次登记（pass、fail、defer、accept）追加一行，复审轮次按它计数。 */
export function prLogFile(root, pr) {
  return path.join(gitCommonDir(root), 'engineering-gate', 'pr', pr, 'log.jsonl');
}

/** PR 审查记录文件：git 公共目录下 engineering-gate/pr/<编号>/<kind>.json（复审与合并可能在不同工作树进行，所以不放 recordDir）。 */
export function prRecordFile(root, pr, kind) {
  return path.join(gitCommonDir(root), 'engineering-gate', 'pr', pr, `${kind}.json`);
}

/** 计算主干与被审提交的共同基准，无法解析时由覆盖判定保守处理。 */
export function forkPoint(root, baseRef, commit) {
  const r = git(root, ['merge-base', baseRef, commit]);
  return r.ok ? r.out.trim() : null;
}

/** 取锁的默认参数：retryMs 内对暂态争用（别的进程正在改同一个锁引用）重试。 */
export const LOCK_DEFAULTS = { retryMs: 3000 };
/** git 自己等待引用锁文件的时间（core.filesRefLockTimeout）：另一个 git 进程正在改同一个引用（几毫秒）时由 git 等过去。 */
const GIT_REF_LOCK_WAIT_MS = 200;

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const lockError = (code, message) => Object.assign(new Error(message), { code });
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
const safeName = (name) => name.replace(/[^A-Za-z0-9._-]/g, '_');

/**
 * 改锁引用的意向登记（只用于诊断）：本套件每次对锁引用运行 git update-ref 之前，在 <公共目录>/engineering-gate/lock-intents/<锁名>/
 * 独占创建一个写着本进程 pid 的文件，git 返回后删除。拿不到锁时据此说明是不是有活着的本套件进程正在改这个引用。返回 git 的结果。
 */
function withIntent(intents, run) {
  fs.mkdirSync(intents, { recursive: true });
  const file = path.join(intents, `${process.pid}-${crypto.randomUUID()}`);
  fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
  try { return run(); } finally { fs.rmSync(file, { force: true }); }
}

/** 别的、还活着的本套件进程正在改这个锁引用时返回它们的 pid；读不出 pid 的意向按活着计。只读，不删任何文件。 */
function liveIntentPids(intents) {
  let names = [];
  try { names = fs.readdirSync(intents); } catch { return []; }
  return names.map((n) => Number.parseInt(n, 10)).filter((pid) => pid !== process.pid && (!Number.isInteger(pid) || pidAlive(pid))).map((pid) => (Number.isInteger(pid) ? pid : '读不出'));
}

/**
 * 互斥锁（不等待活着的持有者，被占用就报错）。用 git 引用的比较交换实现：`git update-ref <引用> <新值> <旧值>` 在 git 自己的独占锁文件下核对旧值再改，是原子的。
 * 引用 refs/engineering-gate/locks/<name> 指向一个记着持有者（pid、开始时间、随机令牌）的对象；引用在仓库的公共目录里，各工作树共用。
 * 取锁：引用不存在时创建（旧值写空）；存在而持有者进程已不在时，从判定失效的那个对象比较交换成自己的。换成之后再读一次，引用确实指向自己的对象才算取到。
 * 正常争用先由 git 等待引用锁文件（core.filesRefLockTimeout），再在 retryMs 内有界重试。
 * git 自己的引用锁文件 <引用>.lock 一律不自动删除：它不带持有者身份，套件看不到实际持锁的 git 进程，任何自动删除都可能删掉活锁。
 * 拿不到时的错误带 code，调用方按它区分：
 *   EK_LOCK_BUSY       持有者还活着（持锁多久都不回收：慢请求、进程暂停）
 *   EK_LOCK_BROKEN     持有者信息读不出，要人确认后手动删除引用
 *   EK_LOCK_CONTENDED  retryMs 内一直没换成：别的进程正在改这个引用，或 git 的引用锁文件一直在。信息里写明锁文件存在多久、
 *                      有没有活着的本套件进程在改这个引用，以及确认没有 git 进程后要删除的文件（git 异常退出留下的残留只能这样人工清理）。
 * 释放：只在引用仍指向自己的对象时删除，失败时有界重试；仍失败（含释放路径里的任何出错）只写警告，fn 的返回值或异常原样交回。
 * 进程退出后没释放的锁按“持有者已不在”回收。opts：{ retryMs }，缺省见 LOCK_DEFAULTS。
 */
export function withLock(root, name, fn, label = `锁 ${name}`, opts = {}) {
  const { retryMs } = { ...LOCK_DEFAULTS, ...opts };
  const ref = `refs/engineering-gate/locks/${name}`;
  const run = (args, input) => spawnSync('git', args, { cwd: root, encoding: 'utf8', input });
  const common = path.resolve(root, run(['rev-parse', '--git-common-dir']).stdout.trim());
  const intents = path.join(common, 'engineering-gate', 'lock-intents', safeName(name));
  const update = (args) => withIntent(intents, () => run(['-c', `core.filesRefLockTimeout=${GIT_REF_LOCK_WAIT_MS}`, 'update-ref', ...args]));
  const read = () => run(['rev-parse', '--verify', '--quiet', ref]).stdout?.trim() ?? '';
  const made = run(['hash-object', '-w', '--stdin'], JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token: crypto.randomUUID() }));
  if (made.status !== 0) throw new Error(`${label}：写不出持有者信息（git hash-object 失败）：${String(made.stderr).trim()}`);
  const mine = made.stdout.trim();
  const holder = (sha) => (sha ? run(['cat-file', '-p', sha]).stdout ?? '' : '');
  const gitLock = path.join(common, ...ref.split('/')) + '.lock';

  /** 比较交换没成时的说明：git 的引用锁文件在不在、在了多久、有没有活着的本套件进程在改这个引用。 */
  const blocked = (stderr) => {
    const stat = fs.statSync(gitLock, { throwIfNoEntry: false });
    if (!stat) return String(stderr ?? '').trim() || '引用在比较交换时被别的进程改动';
    const age = Math.round((Date.now() - stat.mtimeMs) / 1000);
    const live = liveIntentPids(intents);
    const who = live.length ? `本套件进程 ${live.join('、')} 正在改这个引用` : '没有活着的本套件进程在改这个引用，可能是 git 异常退出留下的残留';
    return `git 的引用锁文件 ${gitLock} 已存在 ${age} 秒（${who}）；它不会自动删除：确认没有 git 进程在改 ${ref} 后手动删除该文件再重试`;
  };

  const deadline = Date.now() + retryMs;
  for (;;) {
    const current = read();
    if (current === mine) break;
    let expected = '';
    if (current) {
      const text = holder(current);
      let pid = null;
      try { pid = JSON.parse(text).pid; } catch { pid = null; }
      if (!Number.isInteger(pid)) throw lockError('EK_LOCK_BROKEN', `${label}被占用：持有者信息读不出（${ref}）；确认没有进程在用后运行 git update-ref -d ${ref} 删除`);
      if (!ownerGone(text)) throw lockError('EK_LOCK_BUSY', `${label}被占用：${text.trim()}`);
      expected = current;
    }
    const swapped = update([ref, mine, expected]);
    if (swapped.status === 0 && read() === mine) break;
    if (Date.now() >= deadline) {
      throw lockError('EK_LOCK_CONTENDED', `${label}暂时取不到：${swapped.status === 0 ? '比较交换后引用不是自己的对象' : blocked(swapped.stderr)}；稍后重试`);
    }
    sleepMs(20 + Math.floor(Math.random() * 40));
  }
  try {
    return fn();
  } finally {
    let why = '';
    try {
      const until = Date.now() + retryMs;
      for (;;) {
        const released = update(['-d', ref, mine]);
        if (released.status === 0) { why = ''; break; }
        if (read() !== mine) { why = `引用已不指向自己的对象：${String(released.stderr).trim()}`; break; }
        why = blocked(released.stderr);
        if (Date.now() >= until) break;
        sleepMs(20 + Math.floor(Math.random() * 40));
      }
    } catch (e) {
      why = `释放时出错：${e.message}`;
    }
    if (why) process.stderr.write(`警告：${label}没有释放（${ref}）：${why}；本进程退出后这把锁会按“持有者已不在”被回收\n`);
  }
}

/**
 * 0.9.x 及更早版本的 PR 锁：目录 <git 公共目录>/engineering-gate/pr/<编号>/lock（mkdir 建，owner.json 记持有者）。
 * 升级期间同一仓库的不同工作树可能装着新旧两个版本：新版取到引用锁后再按旧版同样的算法取这个目录锁，两边才互斥。
 * 失效判定与回收照抄旧版：持有者进程已不在，或没写成 owner.json 且超过十分钟；回收用同级 reclaim 目录互斥。
 * reclaim 目录残留（旧版回收者中途退出，或还在回收）一律不自动删除：它不记持有者，删掉可能和正在回收的旧版进程冲突；报占用并写明要人工确认后删除。
 * 释放时读写目录锁出错只写警告，fn 的返回值或异常原样交回。
 */
function withLegacyPrDirLock(root, no, fn, label) {
  const parent = path.dirname(prLogFile(root, no));
  const lock = path.join(parent, 'lock');
  const ownerFile = path.join(lock, 'owner.json');
  const owner = () => {
    try { return fs.readFileSync(ownerFile, 'utf8'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; return ''; }
  };
  const stale = () => {
    const stat = fs.statSync(lock, { throwIfNoEntry: false });
    if (!stat) return false;
    const text = owner();
    let pid = null;
    try { pid = JSON.parse(text).pid; } catch { pid = null; }
    if (Number.isInteger(pid)) return ownerGone(text);
    return Date.now() - stat.mtimeMs > 600000;
  };
  const occupied = () => lockError('EK_LOCK_BUSY', `${label}被占用（旧版套件的目录锁 ${lock}）：${owner().trim() || '持有者信息还没写成'}`);
  // Windows 上目录正被别的进程删除、还没删完时，mkdir 报 EPERM 或 EACCES：这是暂态争用，不是故障
  const deleting = (e) => ['EPERM', 'EACCES'].includes(e.code) && lockError('EK_LOCK_CONTENDED', `${label}暂时取不到：旧版套件的目录锁 ${lock} 正被删除（${e.code}）；稍后重试`);
  try {
    fs.mkdirSync(lock);
  } catch (e) {
    if (deleting(e)) throw deleting(e);
    if (e.code !== 'EEXIST') throw e;
    if (!stale()) throw occupied();
    const reclaim = path.join(parent, 'reclaim');
    try { fs.mkdirSync(reclaim); }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const age = Math.round((Date.now() - (fs.statSync(reclaim, { throwIfNoEntry: false })?.mtimeMs ?? Date.now())) / 1000);
      throw lockError('EK_LOCK_BUSY', `${label}被占用：旧版套件的回收目录 ${reclaim} 已存在 ${age} 秒（旧版进程正在回收，或回收中途退出留下的）；它不会自动删除：确认没有旧版套件进程在运行后手动删除它再重试`);
    }
    try {
      if (stale()) fs.rmSync(lock, { recursive: true });
      try { fs.mkdirSync(lock); }
      catch (err) { if (err.code === 'EEXIST') throw occupied(); throw deleting(err) || err; }
    } finally { fs.rmdirSync(reclaim); }
  }
  const identity = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token: crypto.randomUUID() });
  try {
    fs.writeFileSync(ownerFile, identity);
    return fn();
  } finally {
    try {
      const now = owner();
      if (!now || now === identity) fs.rmSync(lock, { recursive: true, force: true });
    } catch (e) {
      process.stderr.write(`警告：${label}的旧版目录锁 ${lock} 没有释放：${e.message}；确认没有进程在用后手动删除\n`);
    }
  }
}

/** 序列化同一 PR 的同步登记、收口与合并核对（各工作树共用同一把锁；与旧版套件的目录锁同时持有）。opts 同 withLock。 */
export function withPrLock(root, pr, fn, opts = {}) {
  const no = prNumber(pr);
  fs.mkdirSync(path.dirname(prLogFile(root, no)), { recursive: true });
  const label = `PR #${pr} 的登记锁`;
  return withLock(root, `pr-${no}`, () => withLegacyPrDirLock(root, no, fn, label), label, opts);
}
