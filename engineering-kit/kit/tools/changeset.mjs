// 反向提炼的变更集（源端工具）：把从项目里得到的经验，整理为跨组件的一组改动（提案），应用到整包源码。
// 业务含义（对应全局 CLAUDE.md 的“经验提炼”）：
//   - 来源是用户本人的决定或做法（source: user）：可以直接应用。
//   - 来源是 agent 总结的（source: agent）：只能先作为提案待确认；只有用户确认后，才以 --approved 应用。
//   两种来源都走同一条原子路径：先备份改动涉及的文件，应用，运行套件测试；测试失败则整体恢复。
//   应用后不提交、不打标签；由 release.mjs 在检查通过后提交并打版本标签。版本回滚靠标签。
// 变更集格式（JSON）：
//   { id, title, source: "user"|"agent", rationale, recommended?, bumpTo?, ops: [ {op:"write", file, content} | {op:"replace", file, from, to} ] }
// file 相对整包根目录；不允许绝对路径、..、.git、changesets/ 目录。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../gate/lib.mjs';

/** 整包根目录（本文件位于 kit/tools，整包根为上两级）。 */
export const DEFAULT_BUNDLE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 校验变更集结构；不合法抛错。 */
export function validateChangeset(c) {
  const errs = [];
  if (!c || typeof c !== 'object') throw new Error('变更集必须是 JSON 对象');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(c.id || ''))) errs.push('id 只能是小写字母、数字和连字符');
  if (!c.title) errs.push('缺少 title');
  if (c.source !== 'user' && c.source !== 'agent') errs.push('source 只能是 user 或 agent');
  if (!c.rationale) errs.push('缺少 rationale（依据）');
  if (c.bumpTo !== undefined && !/^\d+\.\d+\.\d+$/.test(c.bumpTo)) errs.push('bumpTo 必须是 X.Y.Z');
  if (!Array.isArray(c.ops) || c.ops.length === 0) errs.push('ops 必须是非空数组');
  for (const op of c.ops || []) {
    const f = String(op.file || '');
    if (!f || path.isAbsolute(f) || f.split(/[\\/]/).includes('..') || /^(\.git|changesets)(\/|$)/.test(f.replace(/\\/g, '/'))) {
      errs.push(`非法的 file：${f}`);
      continue;
    }
    if (op.op === 'write') {
      if (typeof op.content !== 'string') errs.push(`${f}：write 需要 content`);
    } else if (op.op === 'replace') {
      if (typeof op.from !== 'string' || typeof op.to !== 'string' || !op.from) errs.push(`${f}：replace 需要 from 与 to`);
    } else errs.push(`${f}：未知 op ${op.op}`);
  }
  if (errs.length) throw new Error(`变更集 ${c.id || '?'} 校验失败：\n  - ${errs.join('\n  - ')}`);
  return c;
}

/** 变更集目录：pending（待确认或待应用）与 applied（已应用的记录，只追加）。 */
export function changesetDirs(bundleDir) {
  const base = path.join(bundleDir, 'changesets');
  return { pending: path.join(base, 'pending'), applied: path.join(base, 'applied') };
}

/** 登记一个变更集为提案（写入 pending）。同 id 已存在则拒绝，不覆盖。 */
export function proposeChangeset({ bundleDir = DEFAULT_BUNDLE_DIR, changeset }) {
  validateChangeset(changeset);
  const { pending, applied } = changesetDirs(bundleDir);
  const f = path.join(pending, `${changeset.id}.json`);
  if (fs.existsSync(f) || fs.existsSync(path.join(applied, `${changeset.id}.json`))) throw new Error(`变更集 ${changeset.id} 已存在`);
  fs.mkdirSync(pending, { recursive: true });
  fs.writeFileSync(f, `${JSON.stringify(changeset, null, 2)}\n`);
  return f;
}

/**
 * 待确认列表：推荐项在前，同推荐状态下用户本人来源在前，再按 id 排序。
 * 返回 [{ id, title, source, recommended, bumpTo, files }]。
 */
export function listPending(bundleDir = DEFAULT_BUNDLE_DIR) {
  const { pending } = changesetDirs(bundleDir);
  if (!fs.existsSync(pending)) return [];
  return fs
    .readdirSync(pending)
    .filter((n) => n.endsWith('.json'))
    .map((n) => validateChangeset(JSON.parse(fs.readFileSync(path.join(pending, n), 'utf8'))))
    .map((c) => ({
      id: c.id,
      title: c.title,
      source: c.source,
      recommended: c.recommended === true,
      bumpTo: c.bumpTo ?? null,
      files: [...new Set(c.ops.map((o) => o.file))],
    }))
    .sort((a, b) => Number(b.recommended) - Number(a.recommended) || (a.source === 'user' ? -1 : 1) - (b.source === 'user' ? -1 : 1) || a.id.localeCompare(b.id));
}

/** 套件测试命令：列出 kit/tests 下的测试文件（不含 changeset.test.mjs，避免递归）。 */
function defaultCheck(bundleDir) {
  const dir = path.join(bundleDir, 'kit', 'tests');
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.test.mjs') && n !== 'changeset.test.mjs').sort().map((n) => path.join('tests', n));
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: path.join(bundleDir, 'kit'), encoding: 'utf8', timeout: 900000 });
  return { ok: r.status === 0, output: `${r.stdout || ''}${r.stderr || ''}` };
}

/**
 * 应用变更集（原子）：备份 → 写入 → 运行套件测试 → 通过则更新版本并移入 applied；失败则整体恢复。
 * source 为 agent 时必须 approved=true（用户已确认）。不提交、不打标签。
 */
export function applyChangeset({ bundleDir = DEFAULT_BUNDLE_DIR, id, approved = false, checkRunner = defaultCheck }) {
  const { pending, applied } = changesetDirs(bundleDir);
  const src = path.join(pending, `${id}.json`);
  if (!fs.existsSync(src)) throw new Error(`找不到待应用的变更集 ${id}`);
  const c = validateChangeset(JSON.parse(fs.readFileSync(src, 'utf8')));
  if (c.source === 'agent' && !approved) throw new Error(`变更集 ${id} 来自 agent 的总结，须先由用户确认后再应用（--approved）`);

  const snapshot = new Map();
  const remember = (rel) => {
    if (snapshot.has(rel)) return;
    const abs = path.join(bundleDir, rel);
    snapshot.set(rel, fs.existsSync(abs) ? fs.readFileSync(abs) : null);
  };
  const restore = () => {
    for (const [rel, buf] of snapshot) {
      const abs = path.join(bundleDir, rel);
      if (buf === null) fs.rmSync(abs, { force: true });
      else fs.writeFileSync(abs, buf);
    }
  };
  try {
    for (const op of c.ops) {
      remember(op.file);
      const abs = path.join(bundleDir, op.file);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (op.op === 'write') fs.writeFileSync(abs, op.content);
      else {
        const text = fs.readFileSync(abs, 'utf8');
        const n = text.split(op.from).length - 1;
        if (n !== 1) throw new Error(`${op.file}：替换的原文必须恰好出现一次（实际 ${n} 次）`);
        fs.writeFileSync(abs, text.replace(op.from, () => op.to));
      }
    }
    if (c.bumpTo) {
      const bj = path.join(bundleDir, 'bundle.json');
      const j = JSON.parse(fs.readFileSync(bj, 'utf8'));
      remember('bundle.json');
      remember('kit/VERSION');
      j.bundleVersion = c.bumpTo;
      fs.writeFileSync(bj, `${JSON.stringify(j, null, 2)}\n`);
      fs.writeFileSync(path.join(bundleDir, 'kit', 'VERSION'), `${c.bumpTo}\n`);
    }
    const check = checkRunner(bundleDir);
    if (!check.ok) throw new Error(`套件测试未通过，已恢复改动前的状态：\n${check.output.slice(-2000)}`);
  } catch (e) {
    restore();
    throw e;
  }
  fs.mkdirSync(applied, { recursive: true });
  const record = { ...c, appliedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(applied, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
  fs.rmSync(src);
  return { ok: true, id, bumpTo: c.bumpTo ?? null, files: [...snapshot.keys()] };
}

// 命令行入口：list 列出待确认；apply <id> [--approved] 应用；propose <变更集.json> 登记为提案。
if (isMain(import.meta.url)) {
  const [cmd, arg] = process.argv.slice(2);
  const usage = '用法：node kit/tools/changeset.mjs list | apply <id> [--approved] | propose <变更集.json>';
  if (!['list', 'apply', 'propose'].includes(cmd) || (cmd !== 'list' && !arg)) {
    console.error(usage);
    process.exit(2);
  }
  try {
    if (cmd === 'list') {
      const items = listPending();
      if (items.length === 0) console.log('没有待确认的变更集');
      for (const i of items) console.log(`${i.recommended ? '[推荐] ' : ''}${i.id}  ${i.title}  来源：${i.source}  涉及：${i.files.join('、')}${i.bumpTo ? `  升版：${i.bumpTo}` : ''}`);
    } else if (cmd === 'apply') {
      const r = applyChangeset({ id: arg, approved: process.argv.includes('--approved') });
      console.log(`已应用 ${r.id}（未提交、未打标签），改动文件：${r.files.join('、')}`);
    } else {
      console.log(`已登记提案：${proposeChangeset({ changeset: JSON.parse(fs.readFileSync(arg, 'utf8')) })}`);
    }
  } catch (e) {
    console.error(`失败：${e.message}`);
    process.exit(1);
  }
}
