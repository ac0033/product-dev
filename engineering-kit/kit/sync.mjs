// 工程闸门同步器：把本套件（闸门脚本、钩子、模板）一键装进任意 git 项目；也可检查已装版本是否漂移。
// 业务含义：
//   - 套件文件（scripts/engineering/ 下的 gate、hooks、VERSION）由套件拥有，同步时更新；但若项目里改过且不是套件记录的版本，
//     视为本地修改：默认不覆盖并报告冲突，--force 才覆盖。套件版本记在 scripts/engineering/kit.lock.json。
//   - 项目自己的配置（engineering.config.json、scripts/engineering/exempt.json）只在首次创建，之后不动。
//   - .claude/settings.json 只追加本套件的钩子，保留原有内容；JSON 不合法时整体报错，且不写入任何文件。
//   - git pre-push 钩子只在没有其他钩子时安装；已有其他钩子时不覆盖，只给出提示。
// 用法：
//   node sync.mjs --target <项目目录> [--dry-run] [--force] [--no-hooks]   安装或升级
//   node sync.mjs --target <项目目录> --check                              只检查是否漂移（有漂移退出码 1）
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './gate/lib.mjs';

/** 套件目录（本文件所在目录）。 */
const KIT = path.dirname(fileURLToPath(import.meta.url));
/** 项目内套件目录（相对项目根）。 */
const TARGET_DIR = 'scripts/engineering';
/** 写在 pre-push 钩子里的标记，用来识别这是本套件安装的钩子。 */
const HOOK_MARK = 'engineering-kit:pre-push';
/** Claude Code 钩子：事件、匹配器与脚本名。 */
const CLAUDE_HOOKS = [
  { event: 'PreToolUse', matcher: 'Bash|PowerShell', script: 'pre-bash.mjs' },
  { event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit', script: 'post-edit.mjs' },
];
/** 只在项目里不存在时创建、之后归项目所有的文件。 */
const CREATE_ONCE = [
  { src: 'templates/engineering.config.json', dst: 'engineering.config.json' },
  { src: 'templates/exempt.json', dst: `${TARGET_DIR}/exempt.json` },
];

/** sha256（十六进制）。 */
function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 套件拥有的文件：源（套件内相对路径）与目标（项目内相对路径）。 */
export function kitFiles() {
  const out = [];
  const gateDir = path.join(KIT, 'gate');
  for (const f of fs.readdirSync(gateDir).filter((x) => x.endsWith('.mjs')).sort()) {
    out.push({ src: `gate/${f}`, dst: `${TARGET_DIR}/gate/${f}` });
  }
  for (const f of ['pre-bash.mjs', 'post-edit.mjs']) out.push({ src: `hooks/${f}`, dst: `${TARGET_DIR}/hooks/${f}` });
  out.push({ src: 'VERSION', dst: `${TARGET_DIR}/VERSION` });
  return out;
}

/** 当前套件版本号。 */
function kitVersion() {
  return fs.readFileSync(path.join(KIT, 'VERSION'), 'utf8').trim();
}

/** 项目的 pre-push 钩子路径（绝对路径）；不是 git 仓库时返回 null。 */
function gitHookPath(target) {
  const r = spawnSync('git', ['-C', target, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks/pre-push'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** 把本套件的 Claude 钩子追加进 settings 对象（已有则不重复，其他配置原样保留）。 */
function mergeSettings(obj) {
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

/**
 * 计划并（非 dry-run 时）执行同步。先完成全部校验与计划，再统一写入，
 * 所以 settings.json 不合法等错误发生时不会留下半成品。
 * 返回 { ok, version, dryRun, actions, conflicts, messages }。
 */
export function syncKit({ target, dryRun = false, force = false, hooks = true }) {
  const root = path.resolve(target);
  const version = kitVersion();
  const lockFile = path.join(root, TARGET_DIR, 'kit.lock.json');
  const lock = fs.existsSync(lockFile) ? JSON.parse(fs.readFileSync(lockFile, 'utf8')) : { version: null, files: {} };
  const actions = [];
  const conflicts = [];
  const messages = [];
  const writes = [];
  const lockFiles = { ...lock.files };

  for (const { src, dst } of kitFiles()) {
    const content = fs.readFileSync(path.join(KIT, src));
    const want = sha(content);
    const abs = path.join(root, dst);
    const cur = fs.existsSync(abs) ? sha(fs.readFileSync(abs)) : null;
    if (cur === want) {
      lockFiles[dst] = want;
      actions.push({ type: 'skip', file: dst });
      continue;
    }
    const recorded = lock.files[dst];
    const locallyModified = cur !== null && (recorded === undefined || cur !== recorded);
    if (locallyModified && !force) {
      conflicts.push(dst);
      actions.push({ type: 'conflict', file: dst });
      messages.push(`冲突：${dst} 与套件版本不同，且项目里有本地修改，未覆盖（确认后用 --force 覆盖）`);
      continue;
    }
    actions.push({ type: cur === null ? 'create' : 'update', file: dst });
    writes.push({ abs, content });
    lockFiles[dst] = want;
  }

  for (const { src, dst } of CREATE_ONCE) {
    const abs = path.join(root, dst);
    if (fs.existsSync(abs)) {
      actions.push({ type: 'keep', file: dst });
      continue;
    }
    actions.push({ type: 'create', file: dst });
    writes.push({ abs, content: fs.readFileSync(path.join(KIT, src)) });
  }

  if (hooks) {
    const sFile = path.join(root, '.claude', 'settings.json');
    const before = fs.existsSync(sFile) ? fs.readFileSync(sFile, 'utf8') : null;
    let obj = {};
    if (before !== null) {
      try {
        obj = JSON.parse(before);
      } catch (e) {
        throw new Error(`.claude/settings.json 不是合法 JSON，已停止，未写入任何文件：${e.message}`);
      }
    }
    const text = `${JSON.stringify(mergeSettings(obj), null, 2)}\n`;
    if (text === before) actions.push({ type: 'skip', file: '.claude/settings.json' });
    else {
      actions.push({ type: before === null ? 'create' : 'update', file: '.claude/settings.json' });
      writes.push({ abs: sFile, content: text });
    }

    const hookFile = gitHookPath(root);
    const hookText = fs.readFileSync(path.join(KIT, 'hooks', 'pre-push.sh'), 'utf8');
    if (!hookFile) messages.push('目标目录不是 git 仓库，未安装 pre-push 钩子');
    else if (!fs.existsSync(hookFile)) {
      actions.push({ type: 'create', file: '.git/hooks/pre-push' });
      writes.push({ abs: hookFile, content: hookText, exec: true });
    } else {
      const cur = fs.readFileSync(hookFile, 'utf8');
      if (!cur.includes(HOOK_MARK)) {
        messages.push('已有其他 pre-push 钩子，未覆盖。请在其中加入一行：node scripts/engineering/gate/verify.mjs');
        actions.push({ type: 'conflict', file: '.git/hooks/pre-push' });
        conflicts.push('.git/hooks/pre-push');
      } else if (cur !== hookText) {
        actions.push({ type: 'update', file: '.git/hooks/pre-push' });
        writes.push({ abs: hookFile, content: hookText, exec: true });
      } else actions.push({ type: 'skip', file: '.git/hooks/pre-push' });
    }
  }

  if (!dryRun) {
    writes.push({ abs: lockFile, content: `${JSON.stringify({ version, files: lockFiles }, null, 2)}\n` });
    for (const w of writes) {
      fs.mkdirSync(path.dirname(w.abs), { recursive: true });
      fs.writeFileSync(w.abs, w.content);
      if (w.exec) {
        try {
          fs.chmodSync(w.abs, 0o755);
        } catch {
          // Windows 上 chmod 无效，git 仍会按 sh 执行钩子
        }
      }
    }
  }
  return { ok: conflicts.length === 0, version, dryRun, actions, conflicts, messages };
}

/** 检查漂移：每个套件文件的状态为 ok / modified（内容与套件不同）/ missing（不存在）。 */
export function checkKit({ target }) {
  const root = path.resolve(target);
  return kitFiles().map(({ src, dst }) => {
    const abs = path.join(root, dst);
    if (!fs.existsSync(abs)) return { file: dst, state: 'missing' };
    const same = sha(fs.readFileSync(abs)) === sha(fs.readFileSync(path.join(KIT, src)));
    return { file: dst, state: same ? 'ok' : 'modified' };
  });
}

/** 解析命令行参数。 */
function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const i = argv.indexOf('--target');
  return {
    target: i >= 0 ? argv[i + 1] : undefined,
    dryRun: flags.has('--dry-run'),
    force: flags.has('--force'),
    hooks: !flags.has('--no-hooks'),
    check: flags.has('--check'),
  };
}

if (isMain(import.meta.url)) {
  const a = parseArgs(process.argv.slice(2));
  if (!a.target) {
    console.error('用法：node sync.mjs --target <项目目录> [--dry-run] [--force] [--no-hooks]  或  --check');
    process.exit(2);
  }
  try {
    if (a.check) {
      const drift = checkKit({ target: a.target });
      const bad = drift.filter((d) => d.state !== 'ok');
      for (const d of bad) console.log(`[${d.state}] ${d.file}`);
      console.log(bad.length === 0 ? '套件文件与套件版本一致' : `有 ${bad.length} 个文件与套件不一致`);
      process.exit(bad.length === 0 ? 0 : 1);
    }
    const r = syncKit({ target: a.target, dryRun: a.dryRun, force: a.force, hooks: a.hooks });
    console.log(`${r.dryRun ? '[试运行] ' : ''}套件版本 ${r.version}`);
    for (const x of r.actions) console.log(`  [${x.type}] ${x.file}`);
    for (const m of r.messages) console.log(`  ! ${m}`);
    console.log(r.ok ? '同步完成' : '同步完成，但有冲突未处理（见上）');
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`同步失败：${e.message}`);
    process.exit(1);
  }
}
