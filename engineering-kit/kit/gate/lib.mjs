// 工程闸门共享函数：读取配置与豁免、判定改动范围、计算代码树哈希、读写记录、获取全局锁、读取 PR 状态（gh）。
// 业务含义：闸门要回答三件事——这次改动了哪些文件（范围）、这些文件现在的内容是什么（树哈希）、
// 测试与复审记录是不是针对这份内容做的（绑定）。只读 git 与工作区，写入只发生在 git 目录下的记录目录里，
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
// 只比较字符串会让命令静默不执行（例如 Windows 上 D:_软件安装 指向 D:_Software）。
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

/** 读取项目配置（profile 结构或旧版扁平结构）并展开为有效配置；缺失、不是合法 JSON 或结构错误时报错。 */
export function loadConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) throw new Error(`缺少 ${CONFIG_FILE}，请先运行同步脚本创建`);
  let user;
  try {
    user = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${CONFIG_FILE} 不是合法 JSON：${e.message}`);
  }
  return normalizeConfig(user);
}

/** 读取豁免表；没有则为空。豁免只放行被列出的路径，不影响其他文件。 */
export function loadExempt(root) {
  const file = path.join(root, EXEMPT_FILE);
  if (!fs.existsSync(file)) return { testFirst: {}, comments: {}, newFiles: {} };
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { testFirst: j.testFirst || {}, comments: j.comments || {}, newFiles: j.newFiles || {} };
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
  const set = new Set();
  // 基准分支解析不了时必须报错：若静默返回空列表，已提交的功能分支会被判定为“没有改动”而放行（失败放行）。
  const { rev } = baseRevision(root, base);
  if (git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).ok) {
    for (const f of pathLines(git(root, ['diff', '--name-only', rev, 'HEAD']).out)) set.add(f);
    for (const f of pathLines(git(root, ['diff', '--name-only', 'HEAD']).out)) set.add(f);
  }
  for (const f of pathLines(git(root, ['ls-files', '--others', '--exclude-standard']).out)) set.add(f);
  return [...set].sort();
}

/**
 * 本次新增的文件：未跟踪的文件，加上相对基准分支已提交新增（diff-filter=A）的文件。
 */
export function newFiles(root, base) {
  const out = new Set(pathLines(git(root, ['ls-files', '--others', '--exclude-standard']).out));
  if (git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).ok) {
    const { rev } = baseRevision(root, base);
    for (const f of pathLines(git(root, ['diff', '--name-only', '--diff-filter=A', rev, 'HEAD']).out)) out.add(f);
  }
  return [...out].sort();
}

/** 仓库里所有已跟踪与未跟踪（未忽略）的文件，用于判断“是否已有源码或测试”。 */
export function repoFiles(root) {
  return pathLines(git(root, ['ls-files', '--cached', '--others', '--exclude-standard']).out);
}

/** 空树基线与 merge-base 两种情况共用的解析：返回可用于 git diff 的修订。 */
function baseRevision(root, base) {
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

/** 参与闸门记录绑定的文件：本次改动中去掉 reviewIgnore 的部分（纯文档改动不使记录失效）。 */
export function scopeFiles(root, config) {
  return changedFiles(root, config.base).filter((f) => !matchesAny(f, config.reviewIgnore));
}

/**
 * 代码树哈希：对每个文件的路径与内容摘要排序后再取摘要。
 * 文件不存在（已删除）记为 deleted。只看这些文件的当前内容，与是否提交无关。
 */
export function treeHash(root, files) {
  const sorted = [...files].sort();
  const present = sorted.filter((f) => {
    const p = path.join(root, f);
    return fs.existsSync(p) && fs.statSync(p).isFile();
  });
  // 内容哈希交给 git hash-object（与 git add 相同的清洗过滤器）：Windows 的 core.autocrlf 会在 checkout 时
  // 把 LF 改成 CRLF，直接读字节会让同一份提交的哈希变化，从而误判“代码变了”。
  const hashes = new Map();
  if (present.length > 0) {
    const r = spawnSync('git', ['-C', root, 'hash-object', '--stdin-paths'], { input: `${present.join('\n')}\n`, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`计算代码树哈希失败：${r.stderr}`);
    const out = r.stdout.split('\n').filter(Boolean);
    present.forEach((f, i) => hashes.set(f, out[i]));
  }
  const h = crypto.createHash('sha256');
  for (const f of sorted) {
    h.update(`${f}\t${hashes.has(f) ? hashes.get(f) : 'deleted'}\n`);
  }
  return h.digest('hex');
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

/** PR 审查记录文件：git 公共目录下 engineering-gate/pr/<编号>/<kind>.json（复审与合并可能在不同工作树进行，所以不放 recordDir）。 */
export function prRecordFile(root, pr, kind) {
  return path.join(gitCommonDir(root), 'engineering-gate', 'pr', pr, `${kind}.json`);
}
