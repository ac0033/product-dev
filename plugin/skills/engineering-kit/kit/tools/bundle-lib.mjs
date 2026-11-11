// 工程能力包的核心（源端工具，不会被安装进项目）：清单校验、标记块、计划、原子写入（失败整体回滚）、冒烟、锁文件、整包漂移检查。
// 业务含义：同步一个项目是一次事务。先校验整包（清单、源文件、JSON）并算出全部改动，再统一写入，
// 再由冒烟测试检查安装结果，最后写锁文件。任一步失败，已写入的文件全部恢复原样，项目不留半成品。
// 所有权（bundle.json 的 owner）：
//   kit      套件拥有：覆盖更新；项目里有未登记的本地修改时报冲突，--force 才覆盖
//   block    标记块：只替换 <!-- engineering-kit:begin vX --> … end 之间的内容，块外项目内容一字不动
//   project  项目拥有：只在首次创建；配置文件例外，格式不同时只做格式迁移（profile ⇄ 扁平）
//   shared   共享文件（.claude/settings.json）：只追加本套件的钩子，保留其他配置
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeConfig, toFlat, toProfile } from '../gate/config.mjs';
import { applyPreset, scaffoldFiles } from './presets.mjs';

/** 项目内套件目录（相对项目根）。 */
export const TARGET_DIR = 'scripts/engineering';
/** 锁文件（相对项目根）：记录安装的整包版本、每个套件文件与标记块的哈希。 */
export const LOCK_REL = `${TARGET_DIR}/kit.lock.json`;
/** pre-push 钩子里的标记，用来识别这是本套件安装的钩子。 */
export const HOOK_MARK = 'engineering-kit:pre-push';
const OWNERS = new Set(['kit', 'block', 'project', 'shared']);
const KINDS = new Set(['gate', 'hooks', 'git-hook', 'claude-settings', 'rules', 'config', 'project-file', 'docs', 'docs-stages']);
const END_MARK = '<!-- engineering-kit:end -->';

/** sha256（十六进制）。 */
export function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 标记块的开始标记（带版本）。 */
export function beginMark(version) {
  return `<!-- engineering-kit:begin v${version} -->`;
}

/**
 * 查找标记块。没有标记返回 null；标记不成对、顺序错误或重复时抛错（拒绝改写，避免误删项目内容）。
 * 返回 { version, body, start, end }，start/end 为块在原文中的字符位置（end 为块结束之后的位置）。
 */
export function findBlock(text) {
  const begins = [...text.matchAll(/<!-- engineering-kit:begin v([^\s>]+) -->/g)];
  const ends = [...text.matchAll(/<!-- engineering-kit:end -->/g)];
  if (begins.length === 0 && ends.length === 0) return null;
  if (begins.length !== 1 || ends.length !== 1 || begins[0].index > ends[0].index) {
    throw new Error('标记块不平衡：需要恰好一对 engineering-kit:begin / end，且 begin 在前');
  }
  const b = begins[0];
  const e = ends[0];
  return {
    version: b[1],
    body: text.slice(b.index + b[0].length, e.index).replace(/\r\n/g, '\n').trim(),
    start: b.index,
    end: e.index + e[0].length,
  };
}

/** 把标记块写入文本：有块则只替换块内容，没有则追加到末尾；块外内容保持原样。 */
export function applyBlock(text, version, body) {
  if (body.includes(END_MARK) || /<!-- engineering-kit:begin/.test(body)) throw new Error('规则正文不能包含标记行');
  // 换行风格跟随项目原文：原文含 CRLF 则整块用 CRLF，否则用 LF
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const block = [beginMark(version), ...body.trim().split(/\r?\n/), END_MARK].join(eol);
  const found = findBlock(text);
  if (!found) {
    if (text.trim() === '') return `${block}${eol}`;
    // 项目原文一字不动：只在末尾补一个换行（若缺），再空一行追加标记块
    const base = text.endsWith('\n') ? text : `${text}${eol}`;
    return `${base}${eol}${block}${eol}`;
  }
  return text.slice(0, found.start) + block + text.slice(found.end);
}

/** 默认复审者名单里后来新增的名字（0.5.0：插件自带的复审子代理）。升级时只对这些名字给提示。 */
const REVIEWERS_ADDED = ['product-dev:code-reviewer'];

/** 旧版（0.1.0）的清单：没有 bundle.json 的套件版本按它处理，保证能从旧版本回滚。 */
export function legacyBundle() {
  return {
    name: 'engineering-kit',
    bundleVersion: '0.1.0',
    configFormat: 'flat',
    legacy: true,
    components: [
      { id: 'gate', kind: 'gate', owner: 'kit', source: 'kit/gate', pattern: '*.mjs', target: `${TARGET_DIR}/gate` },
      { id: 'hooks', kind: 'hooks', owner: 'kit', source: 'kit/hooks', pattern: '*.mjs', target: `${TARGET_DIR}/hooks` },
      { id: 'version', kind: 'gate', owner: 'kit', source: 'kit/VERSION', target: `${TARGET_DIR}/VERSION` },
      { id: 'git-pre-push', kind: 'git-hook', owner: 'kit', source: 'kit/hooks/pre-push.sh', target: '.git/hooks/pre-push' },
      { id: 'claude-hooks', kind: 'claude-settings', owner: 'shared', target: '.claude/settings.json' },
      { id: 'config', kind: 'config', owner: 'project', source: 'kit/templates/engineering.config.json', target: 'engineering.config.json' },
      { id: 'exempt', kind: 'project-file', owner: 'project', source: 'kit/templates/exempt.json', target: `${TARGET_DIR}/exempt.json` },
    ],
  };
}

/** 读取清单：有 bundle.json 则校验后使用，没有则是旧版套件。 */
export function loadBundle(bundleRoot) {
  const f = path.join(bundleRoot, 'bundle.json');
  if (!fs.existsSync(f)) return legacyBundle();
  let b;
  try {
    b = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    throw new Error(`bundle.json 不是合法 JSON：${e.message}`);
  }
  validateBundle(b, bundleRoot);
  return b;
}

/** 校验清单结构：版本、组件 id 唯一、种类与所有权合法、源存在、目标不越界、JSON 源合法、标记块源合法。 */
export function validateBundle(b, bundleRoot) {
  const errs = [];
  if (typeof b.name !== 'string' || !b.name) errs.push('name 缺失');
  if (!/^\d+\.\d+\.\d+$/.test(String(b.bundleVersion))) errs.push('bundleVersion 必须是 X.Y.Z');
  if (b.configFormat !== 'flat' && b.configFormat !== 'profile') errs.push('configFormat 只能是 flat 或 profile');
  if (!Array.isArray(b.components) || b.components.length === 0) errs.push('components 必须是非空数组');
  const ids = new Set();
  for (const c of b.components || []) {
    if (!c.id || ids.has(c.id)) errs.push(`组件 id 缺失或重复：${c.id}`);
    ids.add(c.id);
    if (!KINDS.has(c.kind)) errs.push(`${c.id}：未知 kind ${c.kind}`);
    if (!OWNERS.has(c.owner)) errs.push(`${c.id}：未知 owner ${c.owner}`);
    if (!c.target || path.isAbsolute(c.target) || c.target.split(/[\\/]/).includes('..')) errs.push(`${c.id}：target 必须是项目内相对路径`);
    if (!c.source) {
      if (c.kind !== 'claude-settings') errs.push(`${c.id}：缺少 source`);
      continue;
    }
    const src = path.join(bundleRoot, c.source);
    if (c.kind === 'docs-stages') {
      if (!fs.existsSync(src)) errs.push(`${c.id}：源文件不存在 ${c.source}`);
      continue;
    }
    if (c.pattern) {
      if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) errs.push(`${c.id}：源目录不存在 ${c.source}`);
    } else if (!fs.existsSync(src)) errs.push(`${c.id}：源文件不存在 ${c.source}`);
    if (errs.length) continue;
    if (c.kind === 'config' || (c.kind === 'project-file' && c.source.endsWith('.json'))) {
      try {
        JSON.parse(fs.readFileSync(src, 'utf8'));
      } catch (e) {
        errs.push(`${c.id}：源 JSON 不合法（${e.message}）`);
      }
    }
    if (c.kind === 'rules') {
      try {
        if (findBlock(fs.readFileSync(src, 'utf8'))) errs.push(`${c.id}：规则源文件不能自带标记行`);
      } catch (e) {
        errs.push(`${c.id}：${e.message}`);
      }
    }
  }
  if (errs.length) throw new Error(`bundle.json 校验失败：\n  - ${errs.join('\n  - ')}`);
  return b;
}

/** 把组件展开为具体文件：[{ abs（源文件绝对路径）, rel（项目内相对路径）}]。 */
export function resolveSources(comp, bundleRoot) {
  const src = path.join(bundleRoot, comp.source);
  if (comp.kind === 'docs-stages') return [];
  if (comp.pattern) {
    const suffix = comp.pattern.replace(/^\*/, '');
    return fs
      .readdirSync(src)
      .filter((n) => n.endsWith(suffix) && fs.statSync(path.join(src, n)).isFile())
      .sort()
      .map((n) => ({ abs: path.join(src, n), rel: `${comp.target}/${n}` }));
  }
  return [{ abs: src, rel: comp.target }];
}

/** 读取项目锁文件；没有或损坏则视为未安装。 */
export function readLock(root) {
  const f = path.join(root, LOCK_REL);
  if (!fs.existsSync(f)) return { files: {}, blocks: {}, bundleVersion: null };
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { files: j.files || {}, blocks: j.blocks || {}, bundleVersion: j.bundleVersion ?? j.version ?? null, configFormat: j.configFormat };
  } catch {
    return { files: {}, blocks: {}, bundleVersion: null };
  }
}

/** git 钩子路径（绝对）；不是 git 仓库时返回 null。 */
export function gitHookPath(root) {
  const r = spawnSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks/pre-push'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** 把本套件的 Claude 钩子追加进 settings 对象（已有则不重复，其他配置原样保留）。 */
export function mergeClaudeSettings(obj) {
  const CLAUDE_HOOKS = [
    { event: 'PreToolUse', matcher: 'Bash|PowerShell', script: 'pre-bash.mjs' },
    { event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit', script: 'post-edit.mjs' },
  ];
  const s = structuredClone(obj);
  s.hooks = s.hooks || {};
  for (const h of CLAUDE_HOOKS) {
    const list = (s.hooks[h.event] = s.hooks[h.event] || []);
    const has = list.some((g) => (g.hooks || []).some((x) => String(x.command || '').includes(`${TARGET_DIR}/hooks/${h.script}`)));
    if (!has) {
      list.push({
        matcher: h.matcher,
        hooks: [{ type: 'command', command: `node "$CLAUDE_PROJECT_DIR/${TARGET_DIR}/hooks/${h.script}"`, timeout: 60 }],
      });
    }
  }
  return s;
}

/** 读取并解析项目里的 JSON；不存在返回 null，不合法抛错（并说明文件名）。 */
function readJsonFile(abs, rel) {
  if (!fs.existsSync(abs)) return null;
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    throw new Error(`${rel} 不是合法 JSON，已停止，未写入任何文件：${e.message}`);
  }
}

/** 文件内容（缓冲）或 null。 */
function readOrNull(abs) {
  return fs.existsSync(abs) ? fs.readFileSync(abs) : null;
}

/** 配置文件的目标内容：按清单要求的格式输出；已是该格式则返回 null（不需要改）。 */
function configContent(existingRaw, templateRaw, wantFormat) {
  if (existingRaw === null) {
    return `${JSON.stringify(wantFormat === 'profile' ? templateRaw : toFlat(templateRaw), null, 2)}\n`;
  }
  const isProfile = existingRaw.profile === 2;
  if (wantFormat === 'profile' && !isProfile) return `${JSON.stringify(toProfile(normalizeConfig(existingRaw)), null, 2)}\n`;
  if (wantFormat === 'flat' && isProfile) return `${JSON.stringify(toFlat(existingRaw), null, 2)}\n`;
  return null;
}

/**
 * 计划：读取项目现状，按清单算出全部改动（不写文件）。
 * 返回 { ops: [{ rel, abs, content, exec, action }], actions, conflicts, messages, newLock }。
 * 任何结构错误在这里抛出，所以到写入阶段时已确认整包可安装。
 */
export function planBundle({ root, bundleRoot, bundle, force = false, hooks = true, preset = null, projectName = 'project' }) {
  const lock = readLock(root);
  const ops = [];
  const actions = [];
  const conflicts = [];
  const messages = [];
  const newLock = { files: {}, blocks: {} };
  const cfgAbs = path.join(root, 'engineering.config.json');
  const cfgRaw = readJsonFile(cfgAbs, 'engineering.config.json');
  const templateCfgComp = bundle.components.find((c) => c.kind === 'config');
  const templateRaw = templateCfgComp ? JSON.parse(fs.readFileSync(path.join(bundleRoot, templateCfgComp.source), 'utf8')) : {};
  // 技术栈预设只在首次创建配置时生效（配置之后由项目维护）；脚手架文件只在不存在时创建。
  const newCfgRaw = preset ? applyPreset(templateRaw, preset) : templateRaw;
  if (preset && cfgRaw) messages.push('engineering.config.json 已存在，--profile 只在首次创建时生效；技术栈设置请手动修改该文件');
  // 项目配置归项目所有，同步不改它；但新规则块和设计文档约定依赖新默认值，旧配置缺了要明确提示，不能让规则和闸门各说各话。
  if (cfgRaw) {
    const cur = normalizeConfig(cfgRaw);
    const tpl = normalizeConfig(templateRaw);
    const missStatus = tpl.hygiene.statusValues.filter((v) => !cur.hygiene.statusValues.includes(v));
    // 阶段目录可以沿用项目自己的名称，只有跨阶段文件用的总览目录是必需的，所以只提示它，避免每次同步都重复提示
    const overview = tpl.layout.stages[0];
    if (missStatus.length) messages.push(`升级提示：engineering.config.json 的 hygiene.statusValues 缺少 ${missStatus.join('、')}（规则 R5 会用到）；同步不改项目配置，请手动加上`);
    // 0.5.0 起默认名单新增的复审者：老项目的名单不会自动更新，用它登记会被拒，所以提示。
    // 只看新增的名字，不比整份默认名单：项目有意删掉别的名字时，不该每次同步都提示一遍。
    const missReviewers = REVIEWERS_ADDED.filter((v) => tpl.reviewers.includes(v) && !cur.reviewers.includes(v));
    if (missReviewers.length) messages.push(`升级提示：engineering.config.json 的 modules.review.reviewers 里没有 ${missReviewers.join('、')}，用这些名字登记复审会被拒；同步不改项目配置，要用的请手动加上，且须合入主干后才生效（不用可忽略）`);
    if (!cur.layout.stages.includes(overview)) messages.push(`升级提示：engineering.config.json 的 layout.stages 里没有 ${overview}。跨阶段文件（项目状态、记录、实施交接）需要这个位置：请手动加上并登记到 docs/README.md；其余阶段目录可以沿用现有名称`);
  }
  if (preset) {
    for (const [rel, content] of Object.entries(scaffoldFiles(preset, projectName))) {
      const abs = path.join(root, rel);
      if (fs.existsSync(abs)) actions.push({ type: 'keep', file: rel });
      else {
        ops.push({ rel, abs, content, action: 'create' });
        actions.push({ type: 'create', file: rel });
      }
    }
  }

  for (const comp of bundle.components) {
    if ((comp.kind === 'claude-settings' || comp.kind === 'git-hook') && !hooks) continue;

    if (comp.kind === 'docs-stages') {
      const stages = cfgRaw ? normalizeConfig(cfgRaw).layout.stages : normalizeConfig(templateRaw).layout.stages;
      const tpl = readOrNull(path.join(bundleRoot, comp.source));
      for (const stage of stages) {
        const rel = comp.target.replace('<stage>', stage);
        const abs = path.join(root, rel);
        if (fs.existsSync(abs)) actions.push({ type: 'keep', file: rel });
        else {
          ops.push({ rel, abs, content: tpl, action: 'create' });
          actions.push({ type: 'create', file: rel });
        }
      }
      continue;
    }

    if (comp.kind === 'git-hook') {
      const hookFile = gitHookPath(root);
      const hookRel = '.git/hooks/pre-push';
      if (!hookFile) {
        messages.push('目标目录不是 git 仓库，未安装 pre-push 钩子');
        continue;
      }
      const text = fs.readFileSync(path.join(bundleRoot, comp.source));
      const cur = readOrNull(hookFile);
      if (cur === null) {
        ops.push({ rel: hookRel, abs: hookFile, content: text, exec: true, action: 'create' });
        actions.push({ type: 'create', file: hookRel });
      } else if (!cur.toString('utf8').includes(HOOK_MARK)) {
        messages.push('已有其他 pre-push 钩子，未覆盖。请在其中加入一行：node scripts/engineering/gate/verify.mjs --pre-push "$@" || exit 1（钩子的 stdin 要原样传给它）');
        actions.push({ type: 'warn', file: hookRel });
      } else if (!cur.equals(text)) {
        ops.push({ rel: hookRel, abs: hookFile, content: text, exec: true, action: 'update' });
        actions.push({ type: 'update', file: hookRel });
      } else actions.push({ type: 'skip', file: hookRel });
      continue;
    }

    if (comp.kind === 'claude-settings') {
      const rel = comp.target;
      const abs = path.join(root, rel);
      const before = readJsonFile(abs, rel);
      const text = `${JSON.stringify(mergeClaudeSettings(before ?? {}), null, 2)}\n`;
      const curText = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
      if (text === curText) actions.push({ type: 'skip', file: rel });
      else {
        ops.push({ rel, abs, content: text, action: curText === null ? 'create' : 'update' });
        actions.push({ type: curText === null ? 'create' : 'update', file: rel });
      }
      continue;
    }

    for (const { abs: srcAbs, rel } of resolveSources(comp, bundleRoot)) {
      const abs = path.join(root, rel);
      const srcBuf = fs.readFileSync(srcAbs);

      if (comp.kind === 'rules') {
        const cur = readOrNull(abs);
        if (cur === null && !comp.createIfMissing) {
          actions.push({ type: 'skip', file: rel });
          continue;
        }
        const next = applyBlock(cur === null ? '' : cur.toString('utf8'), bundle.bundleVersion, srcBuf.toString('utf8'));
        newLock.blocks[rel] = bundle.bundleVersion;
        if (cur !== null && next === cur.toString('utf8')) actions.push({ type: 'skip', file: rel });
        else {
          ops.push({ rel, abs, content: next, action: cur === null ? 'create' : 'update' });
          actions.push({ type: cur === null ? 'create' : 'update', file: rel });
        }
        continue;
      }

      if (comp.kind === 'config') {
        const exists = fs.existsSync(abs);
        const raw = exists ? cfgRaw : null;
        const content = configContent(raw, newCfgRaw, bundle.configFormat);
        if (!exists) {
          ops.push({ rel, abs, content, action: 'create' });
          actions.push({ type: 'create', file: rel });
        } else if (content === null) actions.push({ type: 'keep', file: rel });
        else {
          ops.push({ rel, abs, content, action: 'migrate' });
          actions.push({ type: 'migrate', file: rel });
        }
        continue;
      }

      if (comp.kind === 'project-file' || comp.kind === 'docs') {
        if (fs.existsSync(abs)) actions.push({ type: 'keep', file: rel });
        else {
          ops.push({ rel, abs, content: srcBuf, action: 'create' });
          actions.push({ type: 'create', file: rel });
        }
        continue;
      }

      // kind 为 gate / hooks：套件拥有的文件
      const want = sha(srcBuf);
      const cur = fs.existsSync(abs) ? sha(fs.readFileSync(abs)) : null;
      if (cur === want) {
        newLock.files[rel] = want;
        actions.push({ type: 'skip', file: rel });
        continue;
      }
      const recorded = lock.files[rel];
      const locallyModified = cur !== null && (recorded === undefined || cur !== recorded);
      if (locallyModified && !force) {
        conflicts.push(rel);
        if (recorded !== undefined) newLock.files[rel] = recorded;
        actions.push({ type: 'conflict', file: rel });
        messages.push(`冲突：${rel} 与套件版本不同，且项目里有本地修改，未覆盖（确认后用 --force 覆盖）`);
        continue;
      }
      ops.push({ rel, abs, content: srcBuf, action: cur === null ? 'create' : 'update' });
      actions.push({ type: cur === null ? 'create' : 'update', file: rel });
      newLock.files[rel] = want;
    }
  }

  // 上一版安装过、但新清单已不再包含的套件文件（例如回滚到旧版本后多出来的新文件）：未被改过则删除，改过则报冲突
  for (const rel of Object.keys(lock.files)) {
    if (rel in newLock.files) continue;
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    const cur = sha(fs.readFileSync(abs));
    if (cur === lock.files[rel] || force) {
      ops.push({ rel, abs, del: true, action: 'delete' });
      actions.push({ type: 'delete', file: rel });
    } else {
      conflicts.push(rel);
      actions.push({ type: 'conflict', file: rel });
      messages.push(`冲突：${rel} 已不在新清单里，且项目里有本地修改，未删除（确认后用 --force 删除）`);
    }
  }
  return { ops, actions, conflicts, messages, newLock };
}

/** 运行冒烟测试：用本套件的 smoke.mjs 检查刚安装的项目文件（语法、配置加载、巡检可运行）。 */
export function runSmoke(root) {
  // 冒烟脚本总是用执行同步的这一份（即当前整包的 kit/gate/smoke.mjs），检查的是刚写入项目的文件，可用于任何版本
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'gate', 'smoke.mjs');
  const r = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
  return { ok: r.status === 0, output: `${r.stdout || ''}${r.stderr || ''}` };
}

/**
 * 原子执行计划：写入 → 冒烟 → 写锁。任一步失败，把所有写过的文件恢复原样（新建的删除，改过的还原）。
 * opts.inject 仅供测试：'write'（第二个文件写入时失败）、'smoke'（冒烟失败）、'lock'（写锁失败）。
 */
export function executePlan({ root, bundleRoot, bundle, plan, opts = {} }) {
  const journal = [];
  const createdDirs = [];
  const remember = (abs) => {
    if (journal.some((j) => j.abs === abs)) return;
    journal.push({ abs, original: readOrNull(abs) });
  };
  const ensureDir = (dir) => {
    const missing = [];
    let d = dir;
    while (!fs.existsSync(d)) {
      missing.unshift(d);
      d = path.dirname(d);
    }
    for (const m of missing) {
      fs.mkdirSync(m);
      createdDirs.push(m);
    }
  };
  const write = (abs, content, exec) => {
    remember(abs);
    ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, content);
    if (exec) {
      try {
        fs.chmodSync(abs, 0o755);
      } catch {
        // Windows 上 chmod 无效，git 仍会按 sh 执行钩子
      }
    }
  };
  const rollback = () => {
    for (const j of [...journal].reverse()) {
      if (j.original === null) fs.rmSync(j.abs, { force: true });
      else fs.writeFileSync(j.abs, j.original);
    }
    for (const d of [...createdDirs].reverse()) {
      try {
        fs.rmdirSync(d);
      } catch {
        // 目录非空则保留
      }
    }
  };
  try {
    let n = 0;
    for (const op of plan.ops) {
      if (opts.inject === 'write' && n++ === 1) throw new Error('注入的写入失败（测试）');
      if (op.del) {
        remember(op.abs);
        fs.rmSync(op.abs, { force: true });
      } else write(op.abs, op.content, op.exec);
    }
    const smoke = runSmoke(root);
    if (opts.inject === 'smoke') smoke.ok = false;
    if (!smoke.ok) throw new Error(`冒烟测试未通过，已回滚：\n${smoke.output}`);
    if (opts.inject === 'lock') throw new Error('注入的锁文件写入失败（测试）');
    const lock = {
      bundle: bundle.name,
      bundleVersion: bundle.bundleVersion,
      version: bundle.bundleVersion,
      configFormat: bundle.configFormat,
      files: plan.newLock.files,
      blocks: plan.newLock.blocks,
    };
    write(path.join(root, LOCK_REL), `${JSON.stringify(lock, null, 2)}\n`);
  } catch (e) {
    rollback();
    throw e;
  }
}

/**
 * 整包漂移检查：逐个组件核对项目里的文件是否与清单一致。
 * 返回 { bundleVersion, installedVersion, items: [{ component, file, state, detail? }], ok }。
 * state：ok / modified / missing / outdated / format / missing-block / missing-hook / version。
 */
export function checkBundle({ root, bundleRoot }) {
  const bundle = loadBundle(bundleRoot);
  const lock = readLock(root);
  const items = [];
  const push = (component, file, state, detail) => items.push({ component, file, state, ...(detail ? { detail } : {}) });
  const hookFile = gitHookPath(root);

  for (const comp of bundle.components) {
    if (comp.kind === 'docs-stages') {
      const cfgAbs = path.join(root, 'engineering.config.json');
      const cfg = fs.existsSync(cfgAbs) ? JSON.parse(fs.readFileSync(cfgAbs, 'utf8')) : null;
      const stages = cfg ? normalizeConfig(cfg).layout.stages : normalizeConfig(loadTemplateConfig(bundleRoot, bundle)).layout.stages;
      for (const stage of stages) {
        const rel = comp.target.replace('<stage>', stage);
        push(comp.id, rel, fs.existsSync(path.join(root, rel)) ? 'ok' : 'missing');
      }
      continue;
    }
    if (comp.kind === 'git-hook') {
      const cur = hookFile && fs.existsSync(hookFile) ? fs.readFileSync(hookFile, 'utf8') : null;
      push(comp.id, '.git/hooks/pre-push', cur !== null && cur.includes(HOOK_MARK) ? 'ok' : 'missing');
      continue;
    }
    if (comp.kind === 'claude-settings') {
      const abs = path.join(root, comp.target);
      let state = 'missing';
      if (fs.existsSync(abs)) {
        try {
          const s = JSON.parse(fs.readFileSync(abs, 'utf8'));
          state = JSON.stringify(s).includes(`${TARGET_DIR}/hooks/pre-bash.mjs`) ? 'ok' : 'missing-hook';
        } catch {
          state = 'modified';
        }
      }
      push(comp.id, comp.target, state);
      continue;
    }
    for (const { abs: srcAbs, rel } of resolveSources(comp, bundleRoot)) {
      const abs = path.join(root, rel);
      const exists = fs.existsSync(abs);
      if (comp.kind === 'rules') {
        if (!exists) {
          push(comp.id, rel, comp.createIfMissing ? 'missing' : 'ok');
          continue;
        }
        const found = findBlock(fs.readFileSync(abs, 'utf8'));
        const want = fs.readFileSync(srcAbs, 'utf8').trim();
        if (!found) push(comp.id, rel, 'missing-block');
        else if (found.version !== bundle.bundleVersion) push(comp.id, rel, 'outdated', `v${found.version} -> v${bundle.bundleVersion}`);
        else if (found.body !== want) push(comp.id, rel, 'modified');
        else push(comp.id, rel, 'ok');
        continue;
      }
      if (comp.kind === 'config') {
        if (!exists) push(comp.id, rel, 'missing');
        else {
          const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
          const fmt = raw.profile === 2 ? 'profile' : 'flat';
          push(comp.id, rel, fmt === bundle.configFormat ? 'ok' : 'format', `${fmt} -> ${bundle.configFormat}`);
        }
        continue;
      }
      if (comp.kind === 'project-file' || comp.kind === 'docs') {
        push(comp.id, rel, exists ? 'ok' : 'missing');
        continue;
      }
      // gate / hooks：与源文件逐字节比较
      if (!exists) push(comp.id, rel, 'missing');
      else push(comp.id, rel, sha(fs.readFileSync(abs)) === sha(fs.readFileSync(srcAbs)) ? 'ok' : 'modified');
    }
  }
  if (lock.bundleVersion !== bundle.bundleVersion) {
    push('lock', LOCK_REL, lock.bundleVersion ? 'version' : 'missing', `${lock.bundleVersion ?? '未安装'} -> ${bundle.bundleVersion}`);
  }
  return {
    bundleVersion: bundle.bundleVersion,
    installedVersion: lock.bundleVersion,
    items,
    ok: items.every((i) => i.state === 'ok'),
  };
}

/** 读取清单中的配置模板（用于没有配置文件时推断阶段等默认值）。 */
export function loadTemplateConfig(bundleRoot, bundle) {
  const comp = bundle.components.find((c) => c.kind === 'config');
  return comp ? JSON.parse(fs.readFileSync(path.join(bundleRoot, comp.source), 'utf8')) : {};
}
