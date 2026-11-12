#!/usr/bin/env node
// 综合插件 product-dev 的装配脚本：把各组件复制进插件目录，并写出 BUILD.lock.json。
// 业务含义：插件里“取自组件”的部分不手改，一律由本脚本从组件生成；组件更新后重新运行即可。
// 用法：node tools/build-plugin.mjs [--out <目录>]   （默认写入 plugin/；--out 只写出生成的部分，不含手写文件）
// 只用 Node 内置模块。结果只取决于输入内容：不写时间戳，文件按路径排序。
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 本工具的根目录（独立仓库）：插件成品、组件、脚本、测试都在它下面。 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 插件成品目录，相对 ROOT。 */
export const PLUGIN_DIR = 'plugin';
/** 自有组件的源目录，相对 ROOT。 */
export const COMPONENTS_DIR = 'components';
/** 仓库根的许可文件，相对 ROOT。 */
const REPO_LICENSE = 'LICENSE';
/** 插件里唯一可由用户调用的技能（手写，不由本脚本生成）。 */
export const ENTRY_SKILL = 'product-dev';
/** 插件里手写、不由本脚本生成的文件；另外入口技能的整个目录（入口和它的方法文档）也是手写的。 */
export const HANDWRITTEN = ['.gitattributes', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json', 'THIRD_PARTY_NOTICES.md'];
const ENTRY_DIR = `skills/${ENTRY_SKILL}`;
/** 插件内的相对路径是否属于手写部分。本脚本不生成、不覆盖、不删除这些路径。 */
export const isHandwritten = (rel) => HANDWRITTEN.includes(rel) || rel === ENTRY_DIR || rel.startsWith(`${ENTRY_DIR}/`);
const LOCK = 'BUILD.lock.json';
const MODIFIED_NOTE = '# Modified by the product-dev plugin build: user-invocable set to false. See THIRD_PARTY_NOTICES.md at the plugin root.';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 一组文件（相对路径 → 内容）的哈希：按路径排序后逐个计入路径和内容哈希。 */
export function hashFiles(files) {
  const h = crypto.createHash('sha256');
  for (const rel of [...files.keys()].sort()) h.update(`${rel}\0${sha(files.get(rel))}\n`);
  return h.digest('hex');
}

/** 读出某个目录下的全部文件（相对路径用正斜杠）。 */
export function readTree(dir, out = new Map(), base = dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) readTree(p, out, base);
    else out.set(path.relative(base, p).replace(/\\/g, '/'), fs.readFileSync(p));
  }
  return out;
}

/**
 * 把技能头部改成“模型可加载、不出现在命令菜单”：去掉 disable-model-invocation，user-invocable 统一为 false。
 * note 不为空时在头部加一行 YAML 注释，说明文件被改过（Apache-2.0 第 4(b) 条要求）。
 */
export function hideSkill(buf, note = '') {
  const text = buf.toString('utf8');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!m) throw new Error('SKILL.md 没有文件头');
  const nl = m[0].includes('\r\n') ? '\r\n' : '\n';
  const kept = m[1].split(/\r?\n/).filter((l) => !/^(disable-model-invocation|user-invocable):/.test(l));
  const head = ['---', ...kept, 'user-invocable: false', ...(note ? [note] : []), '---'].join(nl) + nl;
  return Buffer.from(head + text.slice(m[0].length), 'utf8');
}

/** 自有组件：只取 git 已跟踪的文件，这样 *.local.md、测试产物等不会带进插件，结果也不受本机忽略规则影响。 */
function ownFiles(root, src) {
  const files = new Map();
  for (const rel of git(root, 'ls-files', '-z', '--', src).split('\0').filter(Boolean).sort()) {
    const abs = path.join(root, rel);
    if (rel.endsWith('.local.md') || !fs.existsSync(abs)) continue;
    files.set(src === rel ? path.basename(rel) : rel.slice(src.length + 1), fs.readFileSync(abs));
  }
  if (!files.size) throw new Error(`自有组件没有文件：${src}`);
  return files;
}

/**
 * 第三方组件：读本机 vendor 存档里的文件。存档是 git 检出时只取已提交的文件，并且：
 * - 要求这些路径没有本地改动；
 * - 检出时被本机 autocrlf 换成 CRLF 的文本文件还原为 LF（上游指定 eol=crlf 的批处理文件保持 CRLF），
 *   这样结果与上游一致，不随本机 git 配置变化。
 * 上游标为可执行的文件记到 executable 里（Windows 的文件系统不保存这个标记）。
 */
function vendorFiles(repo, sub, keep = () => true) {
  const files = new Map();
  files.executable = [];
  const add = (rel, buf) => {
    const inner = rel === sub ? path.basename(rel) : rel.slice(sub.length + 1);
    if (keep(inner)) files.set(inner, buf);
    return inner;
  };
  if (fs.existsSync(path.join(repo, '.git'))) {
    const dirty = git(repo, 'status', '--porcelain', '--', sub).trim();
    if (dirty) throw new Error(`${repo} 的 ${sub} 有未提交的改动，无法确定版本：\n${dirty}`);
    for (const line of git(repo, 'ls-files', '--eol', '-z', '--', sub).split('\0').filter(Boolean)) {
      const [info, rel] = line.split('\t');
      let buf = fs.readFileSync(path.join(repo, rel));
      if (/\bi\/lf\b/.test(info) && /\bw\/crlf\b/.test(info) && !/eol=crlf/.test(info)) buf = Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
      add(rel, buf);
    }
    for (const line of git(repo, 'ls-files', '-s', '-z', '--', sub).split('\0').filter(Boolean)) {
      const [info, rel] = line.split('\t');
      const inner = rel === sub ? path.basename(rel) : rel.slice(sub.length + 1);
      if (info.startsWith('100755') && files.has(inner)) files.executable.push(inner);
    }
  } else {
    const abs = path.join(repo, sub);
    if (fs.statSync(abs).isFile()) add(sub, fs.readFileSync(abs));
    else for (const [rel, buf] of readTree(abs)) add(`${sub}/${rel}`, buf);
  }
  if (!files.size) throw new Error(`第三方组件没有文件：${repo}/${sub}`);
  return files;
}

const json = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const commitOf = (repo) => (fs.existsSync(path.join(repo, '.git')) ? git(repo, 'rev-parse', 'HEAD').trim() : null);
const merge = (...maps) => Object.assign(new Map(maps.flatMap((m) => [...m])), { executable: maps.flatMap((m) => m.executable || []) });
const withSkill = (files, note) => files.set('SKILL.md', hideSkill(files.get('SKILL.md'), note));
/** 行为用例属于仓库的自身验证，不随插件分发：组件里指向它的相对链接改成仓库网址，装好后仍可到达。 */
const CASES_LINK = '](../../evals/cases.md)';
const CASES_URL = '](https://github.com/ac0033/product-dev/blob/main/evals/cases.md)';
function relinkCases(files) {
  for (const [rel, buf] of files) if (rel.endsWith('.md') && buf.includes(CASES_LINK)) files.set(rel, Buffer.from(buf.toString('utf8').replaceAll(CASES_LINK, CASES_URL)));
  return files;
}

/** 自有部分：每项 { id, dest, component, version, license, changes, files }。 */
function ownParts(root) {
  const kitVersion = json(path.join(root, COMPONENTS_DIR, 'engineering-kit/bundle.json')).bundleVersion;
  const skill = (name, version, changes) => ({
    id: name, dest: `skills/${name}`, component: name, version, license: 'MIT', changes, files: relinkCases(withSkill(ownFiles(root, `${COMPONENTS_DIR}/${name}`))),
  });
  const hidden = '头部加 user-invocable: false';
  return [
    skill('engineering-kit', kitVersion, '头部去掉 disable-model-invocation，加 user-invocable: false'),
    skill('product-design-orchestrator', null, `${hidden}；指向 ../../evals/cases.md 的链接改为仓库网址`),
    skill('product-discovery-prd', null, '无（头部原本就是 user-invocable: false）'),
    skill('prototype-design', null, '无（头部原本就是 user-invocable: false）'),
    skill('system-architecture-design', null, '无（头部原本就是 user-invocable: false）'),
    { id: 'license', dest: 'LICENSE', component: '仓库根 LICENSE', version: null, license: 'MIT', changes: '无', files: ownFiles(root, REPO_LICENSE) },
  ];
}

/**
 * impeccable 的技能文本可能领先于它固定的引擎版本（收录的是上游 main，新命令先写进文档、后随引擎发布）。
 * 这里登记本地适配：去掉引用固定引擎还没有的命令的整节。上游发布带该命令的引擎、升级固定版本后，
 * 构建会报错，提示删掉对应条目、恢复原文。
 */
export const IMPECCABLE_ENGINE_GAPS = [
  { verb: 'audit-storage', heading: '## Save the Report', files: ['reference/audit.md', 'reference/audit.native.md'] },
];
const gapNote = (gap, version) => `<!-- Modified by the product-dev plugin build: removed "${gap.heading.replace(/^#+\s*/, '')}" because the pinned engine ${version} has no \`${gap.verb}\` command. See THIRD_PARTY_NOTICES.md at the plugin root. -->`;

/**
 * 从引擎 Rust 源码的分派函数 `pub fn run(` 的函数体里，取出 match 分支的命令名（如 `"a" | "b" =>`），
 * 以及 `v.starts_with("live")` 这类前缀分派。只看 run 的函数体，文件里别处的字符串 match 不算命令。
 */
export function parseEngineVerbs(source) {
  const start = source.search(/^pub fn run\(/m);
  if (start < 0) throw new Error('引擎源码里没有找到 pub fn run(');
  const close = source.slice(start).search(/^\}/m);
  const body = source.slice(start, close < 0 ? undefined : start + close);
  const verbs = new Set();
  const prefixes = new Set();
  for (const m of body.matchAll(/^\s*("[a-z][a-z0-9-]*"(?:\s*\|\s*"[a-z][a-z0-9-]*")*)\s*=>/gm)) for (const v of m[1].matchAll(/"([^"]+)"/g)) verbs.add(v[1]);
  for (const m of body.matchAll(/^\s*\w+ if \w+\.starts_with\("([a-z0-9-]+)"\)\s*=>/gm)) prefixes.add(m[1]);
  return { verbs, prefixes };
}

/**
 * 合并顶层命令与前缀分派的子模块命令：顶层只把以该前缀开头的命令交给子模块，
 * 子模块里不带前缀的别名（如 live 的 "poll"）从命令行调不到，不算支持。
 */
export function mergeEngineVerbs(router, modules) {
  const verbs = new Set(router.verbs);
  for (const [prefix, mod] of Object.entries(modules)) {
    if (!router.prefixes.has(prefix)) continue;
    for (const v of mod.verbs) if (v.startsWith(prefix)) verbs.add(v);
  }
  return verbs;
}

/**
 * 文本里调用引擎的命令名，返回 命令 → 出现的文件。认两种写法：
 * `"<skill-base-dir>/scripts/impeccable" <命令>`（含 .cmd），以及行内代码里的 `impeccable <命令>` / `npx impeccable <命令>`。
 * `/impeccable polish` 这类技能子命令前面带斜杠，不算。
 */
export function referencedVerbs(files) {
  const out = new Map();
  for (const [rel, buf] of files) {
    if (!rel.endsWith('.md')) continue;
    for (const m of buf.toString('utf8').matchAll(/(?:scripts\/impeccable(?:\.cmd)?"?|`(?:npx )?impeccable)[ \t]+([a-z][a-z0-9-]*)/g)) {
      if (!out.has(m[1])) out.set(m[1], new Set());
      out.get(m[1]).add(rel);
    }
  }
  return out;
}

/** 固定引擎是否支持某个命令（engine.verbs 已含前缀分派到子模块、能从命令行调到的命令）。 */
const engineSupports = (engine, verb) => engine.verbs.has(verb);

/**
 * 去掉 Markdown 里以 heading 开头的一整节（到下一个同级或更高级标题为止，``` 代码块里的 # 行不算标题），
 * 在原位置留一行改动说明。保留原文件的换行符和末尾是否有换行。
 */
export function dropSection(buf, heading, note) {
  const text = buf.toString('utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const trailing = text.endsWith(eol);
  const lines = (trailing ? text.slice(0, -eol.length) : text).split(eol);
  const level = heading.match(/^#+/)[0].length;
  let fenced = false;
  const isHeading = lines.map((l) => {
    if (/^\s*(```|~~~)/.test(l)) { fenced = !fenced; return false; }
    return !fenced && /^#+\s/.test(l);
  });
  const start = lines.findIndex((l, i) => isHeading[i] && l === heading);
  if (start < 0) throw new Error(`没有找到要去掉的一节：${heading}`);
  let end = lines.findIndex((l, i) => i > start && isHeading[i] && l.match(/^#+/)[0].length <= level);
  if (end < 0) end = lines.length;
  let from = start;
  while (from > 0 && lines[from - 1].trim() === '') from -= 1;
  const head = lines.slice(0, from);
  const tail = lines.slice(end);
  const kept = [...head, ...(head.length ? [''] : []), note, ...(tail.length ? ['', ...tail] : [])];
  return Buffer.from(kept.join(eol) + (trailing ? eol : ''), 'utf8');
}

/**
 * 读出固定引擎版本支持的命令：引擎版本取技能目录的 scripts/VERSION，源码取上游仓库的 engine-v<版本> 标签。
 * 要求 vendor/impeccable 是带标签的 git 检出。
 */
function pinnedEngine(repo) {
  if (!fs.existsSync(path.join(repo, '.git'))) throw new Error(`${repo} 不是 git 检出，无法核对固定引擎支持的命令`);
  const version = fs.readFileSync(path.join(repo, 'plugin/skills/impeccable/scripts/VERSION'), 'utf8').trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`impeccable 的 scripts/VERSION 不是 x.y.z 格式：${version}`);
  const tag = `engine-v${version}`;
  let tagCommit;
  try { tagCommit = git(repo, 'rev-parse', '--verify', '--quiet', `${tag}^{commit}`).trim(); } catch { throw new Error(`${repo} 里没有标签 ${tag}，先 git fetch --tags`); }
  const show = (file) => git(repo, 'show', `${tagCommit}:${file}`);
  const verbs = mergeEngineVerbs(parseEngineVerbs(show('crates/cli/src/router.rs')), { live: parseEngineVerbs(show('crates/live/src/lib.rs')) });
  return { version, tagCommit, verbs };
}

/**
 * 按固定引擎核对并适配 impeccable 技能文本：登记的缺口去掉对应一节；
 * 适配后仍引用引擎没有的命令，或登记的缺口引擎已经支持，都报错。返回引擎信息供写入锁文件。
 */
export function adaptToEngine(files, engine, gaps = IMPECCABLE_ENGINE_GAPS) {
  for (const gap of gaps) {
    if (engineSupports(engine, gap.verb)) throw new Error(`固定引擎 ${engine.version} 已支持 ${gap.verb}：删除 IMPECCABLE_ENGINE_GAPS 里的这一条，恢复上游原文`);
    for (const rel of gap.files) {
      if (!files.has(rel)) throw new Error(`本地适配要改的文件不存在：${rel}`);
      files.set(rel, dropSection(files.get(rel), gap.heading, gapNote(gap, engine.version)));
    }
  }
  assertEngineVerbs(files, engine);
  return { version: engine.version, ...(engine.tagCommit ? { tagCommit: engine.tagCommit } : {}), verbs: [...engine.verbs].sort() };
}

/** 文本引用的引擎命令都要在固定引擎里，否则报错并列出命令和所在文件。 */
export function assertEngineVerbs(files, engine) {
  const missing = [...referencedVerbs(files)].filter(([verb]) => !engineSupports(engine, verb)).map(([verb, where]) => `${verb}（${[...where].sort().join('、')}）`);
  if (missing.length) throw new Error(`impeccable 的文本引用了固定引擎 ${engine.version} 没有的命令：${missing.join('；')}。升级固定引擎，或在 IMPECCABLE_ENGINE_GAPS 登记本地适配`);
}

/** 第三方部分；本机没有 vendor 存档时返回 null。 */
function thirdPartyParts(vendor) {
  const [imp, arc, fd] = ['impeccable', 'archify', 'feature-dev'].map((n) => path.join(vendor, n));
  if (![imp, arc, fd].every((d) => fs.existsSync(d))) return null;
  const meta = (component, source, version, repo) => ({ component, source, version, commit: commitOf(repo), license: 'Apache-2.0', thirdParty: true });
  const impMeta = meta('impeccable', 'https://github.com/pbakaus/impeccable', json(path.join(imp, 'plugin/.claude-plugin/plugin.json')).version, imp);
  const arcMeta = meta('archify', 'https://github.com/tt-a1i/archify', json(path.join(arc, 'archify/skill-release.json')).version, arc);
  const fdMeta = meta('feature-dev', 'https://github.com/anthropics/claude-plugins-official', json(path.join(fd, '.claude-plugin/plugin.json')).version, fd);
  const arcExcluded = (rel) => /^examples\/[^/]+\.html$/.test(rel);
  const impFiles = withSkill(merge(vendorFiles(imp, 'plugin/skills/impeccable'), vendorFiles(imp, 'LICENSE'), vendorFiles(imp, 'NOTICE.md')), MODIFIED_NOTE);
  const pinned = pinnedEngine(imp);
  const engine = adaptToEngine(impFiles, pinned);
  const impAgents = vendorFiles(imp, 'plugin/agents');
  assertEngineVerbs(impAgents, pinned);
  const gapChanges = IMPECCABLE_ENGINE_GAPS.map((g) => `${g.files.join('、')} 去掉“${g.heading.replace(/^#+\s*/, '')}”一节并留一行改动说明（固定引擎 ${engine.version} 没有 ${g.verb} 命令）`);
  return [
    {
      id: 'impeccable', dest: 'skills/impeccable', ...impMeta,
      from: ['plugin/skills/impeccable/', 'LICENSE', 'NOTICE.md'],
      changes: ['SKILL.md 头部 user-invocable 由 true 改为 false，并加一行改动说明注释', ...gapChanges].join('；') + '；其余文件原样',
      engine,
      files: impFiles,
    },
    {
      id: 'impeccable-agents', dest: 'agents', listFiles: true, ...impMeta,
      from: ['plugin/agents/'], changes: '无', files: impAgents,
    },
    {
      id: 'archify', dest: 'skills/archify', ...arcMeta,
      from: ['archify/'], excluded: ['examples/*.html（示例图的成品页，只被上游重新生成示例的脚本引用）'],
      changes: 'SKILL.md 头部加 user-invocable: false 和一行改动说明注释；排除示例成品页；其余文件原样',
      files: withSkill(vendorFiles(arc, 'archify', (rel) => !arcExcluded(rel)), MODIFIED_NOTE),
    },
    {
      id: 'feature-dev-agents', dest: 'agents', listFiles: true, ...fdMeta,
      from: ['plugins/feature-dev/agents/'], changes: '无', files: vendorFiles(fd, 'agents', (rel) => rel.endsWith('.md')),
    },
  ];
}

/** 任何生成部分都不得落在手写路径上，否则构建时的清空和写入会毁掉手写内容；落上去就报错。 */
export function assertNotHandwritten(part) {
  const paths = [part.dest, ...[...part.files.keys()].map((rel) => `${part.dest}/${rel}`)];
  // 目标目录是手写目录的上级时（如 skills），清空它同样会删掉手写内容
  const hit = paths.find(isHandwritten) || (!part.listFiles && `${ENTRY_DIR}/`.startsWith(`${part.dest}/`) ? part.dest : undefined);
  if (hit) throw new Error(`生成部分 ${part.id} 会覆盖手写路径 ${hit}`);
}

const lockEntry = ({ files, listFiles, thirdParty, ...rest }) => ({
  ...rest, fileCount: files.size, sha256: hashFiles(files), ...(listFiles ? { files: [...files.keys()].sort() } : {}),
  ...(files.executable?.length ? { executable: [...files.executable].sort() } : {}),
});

/** 装配插件。返回 { lock, thirdPartyBuilt }。 */
export function build({ root = ROOT, out = path.join(root, PLUGIN_DIR), vendor = path.join(root, 'vendor'), log = console.log } = {}) {
  const own = ownParts(root);
  const third = thirdPartyParts(vendor);
  const committedLock = path.join(root, PLUGIN_DIR, LOCK);
  const previous = fs.existsSync(committedLock) ? json(committedLock).parts : [];

  const write = (part) => {
    const dest = path.join(out, part.dest);
    assertNotHandwritten(part);
    if (!part.listFiles) fs.rmSync(dest, { recursive: true, force: true });
    for (const [rel, buf] of part.files) {
      // dest 本身是文件（如 LICENSE）时直接写到 dest
      const target = part.files.size === 1 && !part.dest.includes('/') && part.dest === rel ? dest : path.join(dest, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buf);
      // 在 Windows 上不起作用：提交时还要让 git 记下可执行位，由 plugin-build.test.mjs 核对
      if (part.files.executable?.includes(rel)) fs.chmodSync(target, 0o755);
    }
  };

  own.forEach(write);
  let thirdEntries;
  if (third) {
    fs.rmSync(path.join(out, 'agents'), { recursive: true, force: true });
    third.forEach(write);
    thirdEntries = third.map(lockEntry);
  } else {
    thirdEntries = previous.filter((p) => p.source);
    log(`提示：没有找到第三方组件的本机存档（${vendor}），只重建了自有组件部分；第三方部分保持仓库里已提交的内容。`);
  }
  const lock = { note: '由 tools/build-plugin.mjs 生成，不要手改。', parts: [...own.map(lockEntry), ...thirdEntries] };
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, LOCK), `${JSON.stringify(lock, null, 2)}\n`);
  return { lock, thirdPartyBuilt: Boolean(third) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const i = process.argv.indexOf('--out');
  if (i > 0 && !process.argv[i + 1]) throw new Error('--out 后面要跟目录');
  const out = i > 0 ? path.resolve(process.argv[i + 1]) : undefined;
  const { lock } = build({ out });
  for (const p of lock.parts) console.log(`${p.dest.padEnd(40)} ${String(p.fileCount).padStart(4)} 个文件  ${p.sha256.slice(0, 12)}  ${p.component}${p.version ? ` ${p.version}` : ''}`);
}
