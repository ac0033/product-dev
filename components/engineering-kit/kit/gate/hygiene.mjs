// 巡检（熵管理）：机械检查项目的目录、文件命名、索引、阶段内登记、链接、状态、重复内容、超期草稿、已合并分支与残留工作树。
// 业务含义：项目越做越大，过时、重复、临时文件会悄悄积累。巡检只报告，不删除；删除按项目规则 R8。
// 语义一致性（规则与文档是否矛盾、重复、过时）由子代理复审完成，本脚本只做可机械判断的部分。
// 用法：node scripts/engineering/gate/hygiene.mjs [--json]    有错误时退出码 1
import fs from 'node:fs';
import path from 'node:path';
import { EMPTY_TREE, allowedTopDirs, git, isMain, loadConfig, parseStatusZ, repoRoot, resolveBase } from './lib.mjs';
import crypto from 'node:crypto';

/** 列出仓库中已跟踪和未忽略的文件（相对路径，斜杠分隔）；已在工作区删除但未暂存的文件不算。 */
export function listRepoFiles(root) {
  const r = git(root, ['ls-files', '--cached', '--others', '--exclude-standard']);
  if (!r.ok) throw new Error('无法列出仓库文件（不在 git 仓库中？）');
  return r.out.split('\n').map((s) => s.trim().replace(/\\/g, '/')).filter((f) => f && fs.existsSync(path.join(root, f)));
}

/** 顶层目录名（只看有子路径的文件，即目录）。 */
export function topLevelDirs(files) {
  return [...new Set(files.filter((f) => f.includes('/')).map((f) => f.split('/')[0]))].sort();
}

/** 文件名按分隔符切开后，是否含禁用的片段（如 copy、final、bak）。 */
export function bannedTokensIn(name, tokens) {
  const base = path.basename(name, path.extname(name)).toLowerCase();
  const parts = base.split(/[-_.\s]+/);
  return tokens.filter((t) => parts.includes(String(t).toLowerCase()));
}

/** 取 Markdown 中的相对链接目标（忽略外链、锚点、绝对路径）。 */
export function relativeLinks(text) {
  const out = [];
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const t = m[1].split('#')[0];
    if (!t || /^[a-z]+:/i.test(t) || t.startsWith('/')) continue;
    try {
      out.push(decodeURI(t));
    } catch {
      out.push(t); // 含 % 但不是合法转义（如 50%.md）：按原文
    }
  }
  return out;
}

/** 从文本开头几行读取状态字段（状态：xxx 或 status: xxx）。 */
export function statusOf(text) {
  const m = text.split('\n').slice(0, 15).join('\n').match(/^(?:状态|status)\s*[:：]\s*([^\s]+)/im);
  return m ? m[1].toLowerCase() : null;
}

/** 登记名的规范写法：去掉首尾空白、开头的 ./ 和结尾的斜杠，反斜杠换成斜杠。 */
function entryName(s) {
  return s.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
}

/** 链接目标：普通写法、带标题的写法（a.md "标题"）和尖括号写法（<a b.md>，目标里可以有空格）。 */
const LINK_TARGET = /\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+["'][^"'\n]*["'])?\s*\)/g;

/**
 * 阶段 README 里登记的名字，只认三种写法并要求整名相同：表格每行第一列的整格文字、反引号里的文字、链接目标。
 * 不按子串找：那样会把 spec.md 误当成已登记（README 里只有 my-spec.md）。表格只取第一列：说明列里的词不是登记。
 */
export function registeredNames(text) {
  const names = new Set();
  for (const m of text.matchAll(LINK_TARGET)) {
    const target = (m[1] ?? m[2]).split('#')[0];
    if (!target || /^[a-z]+:/i.test(target) || target.startsWith('/')) continue;
    try {
      names.add(entryName(decodeURI(target)));
    } catch {
      names.add(entryName(target)); // 含 % 但不是合法转义：按原文
    }
  }
  for (const m of text.matchAll(/`([^`\n]+)`/g)) names.add(entryName(m[1]));
  for (const line of text.split('\n')) {
    const row = line.trim();
    if (row.startsWith('|')) names.add(entryName(row.split('|')[1] ?? ''));
  }
  names.delete('');
  return names;
}

/**
 * 阶段内登记检查（规则 R6）：阶段目录里的文件要登记到该阶段的 README。返回错误信息数组。
 * 直接放在阶段目录下的文件登记文件名；子目录里的文件登记相对该阶段目录的路径，或它所在的任一层目录名（如原型目录 prototype/）。
 * 子目录里的文件不认裸文件名：README 登记了 plan.md，不等于 sub/plan.md 也登记了。
 * 不查的：记录目录（即使设在阶段目录之内，按 R6 不登记）、README 自己（文件名不分大小写）、以点开头的文件（如 .gitkeep）。
 * 阶段目录有文件却没有 README 时报一条。
 */
export function unregisteredStageFiles(root, files, stages, recordDirs) {
  const out = [];
  const records = recordDirs.map((d) => `${d.replace(/\/+$/, '')}/`);
  for (const stage of stages) {
    const prefix = `docs/${stage}/`;
    const all = files.filter((f) => f.startsWith(prefix));
    const readme = all.find((f) => /^readme\.md$/i.test(f.slice(prefix.length)));
    const inStage = all.filter((f) => f !== readme && !path.posix.basename(f).startsWith('.') && !records.some((d) => f.startsWith(d)));
    if (inStage.length === 0) continue;
    if (!readme) {
      out.push(`阶段目录 ${prefix} 里有 ${inStage.length} 个文件，但没有该阶段的 README.md，文件无处登记（规则 R6）`);
      continue;
    }
    const names = registeredNames(fs.readFileSync(path.join(root, readme), 'utf8'));
    for (const f of inStage) {
      const parts = f.slice(prefix.length).split('/');
      const candidates = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
      if (!candidates.some((c) => names.has(c))) {
        out.push(`文件未登记到该阶段的 README：${f}（规则 R6；在 ${readme} 表格的第一列登记文件名，子目录里的文件登记相对路径或所在目录名）`);
      }
    }
  }
  return out;
}

/** 解析基准分支；无法解析或为空树时返回 null（巡检只跳过已合并分支检查，不报错）。 */
function baseOrNull(root, base) {
  try {
    const r = resolveBase(root, base);
    return r === EMPTY_TREE ? null : r;
  } catch {
    return null;
  }
}

/** 运行巡检，返回 { root, findings: { error: [], warn: [] }, ok }。不删除、不修改任何文件。 */
export function runHygiene(root) {
  const cfg = loadConfig(root);
  const { layout, hygiene } = cfg;
  const findings = { error: [], warn: [] };
  const err = (msg) => findings.error.push(msg);
  const warn = (msg) => findings.warn.push(msg);
  const files = listRepoFiles(root);
  const dirs = topLevelDirs(files);

  // 1. 顶层目录白名单
  // 源码与测试目录由 glob 推出（如 tests/**/*.test.ts → tests），不必再在白名单里重复登记，避免两处不一致。
  const allowed = allowedTopDirs(layout);
  for (const d of dirs) if (!allowed.has(d)) err(`顶层目录不在白名单：${d}/（允许：${[...allowed].join('、')}）`);

  // 2. 禁用的文件名片段（copy、final、bak 等）
  for (const f of files) {
    const hit = bannedTokensIn(f, hygiene.bannedNameTokens);
    if (hit.length) warn(`文件名含禁用片段（${hit.join('、')}）：${f}`);
  }

  // 3. 文档：死链、索引、状态合法性、超期草稿
  const docFiles = files.filter((f) => f.startsWith('docs/') && f.endsWith('.md') && !f.startsWith('docs/_templates/'));
  for (const f of docFiles) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    for (const link of relativeLinks(text)) {
      const target = path.normalize(path.join(path.dirname(path.join(root, f)), link));
      if (!fs.existsSync(target)) err(`死链：${f} → ${link}`);
    }
    const st = statusOf(text);
    if (st && !hygiene.statusValues.includes(st)) err(`状态不合法（${st}）：${f}（合法值：${hygiene.statusValues.join('、')}）`);
    if (st === 'draft') {
      // 以最近一次提交时间为准（重新克隆后文件时间会归零）；未跟踪的文件退回文件时间
      const ct = Number(git(root, ['log', '-1', '--format=%ct', '--', f]).out.trim());
      const ageDays = (Date.now() - (ct ? ct * 1000 : fs.statSync(path.join(root, f)).mtimeMs)) / 86400000;
      if (ageDays > hygiene.staleDraftDays) warn(`草稿超过 ${hygiene.staleDraftDays} 天未更新：${f}（请确认保留或删除）`);
    }
  }
  const indexFile = path.join(root, 'docs', 'README.md');
  if (fs.existsSync(indexFile)) {
    const idx = fs.readFileSync(indexFile, 'utf8');
    for (const stage of layout.stages) {
      if (fs.existsSync(path.join(root, 'docs', stage)) && !idx.includes(stage)) warn(`阶段目录未登记到索引 docs/README.md：docs/${stage}/`);
    }
  } else warn('缺少文档索引 docs/README.md');
  for (const msg of unregisteredStageFiles(root, files, layout.stages, hygiene.recordDirs)) err(msg);

  // 4. 空目录（docs 与 src 下）
  const walkEmpty = (dir) => {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    if (entries.length === 0) warn(`空目录：${path.relative(root, dir).replace(/\\/g, '/')}/`);
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) walkEmpty(path.join(dir, e.name));
  };
  for (const d of ['docs', 'src']) walkEmpty(path.join(root, d));

  // 5. 重复内容（docs 下内容完全相同的文件）
  const byHash = new Map();
  // 各阶段的 README.md 由模板生成，内容相同是设计如此，不计入重复
  for (const f of files.filter((x) => x.startsWith('docs/') && !/(^|\/)README\.md$/.test(x) && fs.statSync(path.join(root, x)).isFile())) {
    const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex');
    byHash.set(h, [...(byHash.get(h) || []), f]);
  }
  for (const group of byHash.values()) if (group.length > 1) warn(`内容重复：${group.join('、')}`);

  // 6. 记录类文档只追加：已跟踪的记录文件出现修改即报错
  // 工作区里的修改，加上相对基准分支已提交的修改（提交后也要查得到）；基准解析不了时只查工作区。
  const base = baseOrNull(root, cfg.base);
  const isRecord = (f) => hygiene.recordDirs.some((d) => f.startsWith(`${d}/`));
  const modified = new Set();
  const status = git(root, ['status', '--porcelain', '-uall', '-z']);
  if (status.ok) for (const { code, file: f } of parseStatusZ(status.out)) if (code.includes('M')) modified.add(f);
  const mb = base ? git(root, ['merge-base', base, 'HEAD']) : null;
  if (mb?.ok) {
    const committed = git(root, ['diff', '--name-only', '--diff-filter=M', mb.out.trim(), 'HEAD']);
    for (const f of committed.out.split('\n').filter(Boolean)) modified.add(f);
  }
  for (const f of [...modified].sort()) if (isRecord(f)) err(`记录类文档不得修改旧文件（请追加新文件）：${f}`);

  // 7. 已合并的分支与残留的工作树
  const branches = git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  if (branches.ok && base && git(root, ['rev-parse', '--verify', '--quiet', base]).ok) {
    const current = git(root, ['branch', '--show-current']).out.trim();
    for (const b of branches.out.split('\n').filter(Boolean)) {
      if (b === current || b === 'main' || b === 'master') continue;
      const cherry = git(root, ['cherry', base, b]);
      if (cherry.ok && !cherry.out.split('\n').some((l) => l.startsWith('+'))) warn(`分支内容已在 ${base}（可删除，请确认）：${b}`);
    }
  }
  const wt = git(root, ['worktree', 'list', '--porcelain']);
  if (wt.ok) {
    const blocks = wt.out.split('\n\n').filter(Boolean);
    blocks.slice(1).forEach((blk) => {
      const p = (blk.match(/^worktree (.+)$/m) || [])[1];
      const br = (blk.match(/^branch refs\/heads\/(.+)$/m) || [])[1];
      warn(`残留工作树（收工后应清理）：${p}${br ? `（分支 ${br}）` : ''}`);
    });
  }
  return { root, findings, ok: findings.error.length === 0 };
}

if (isMain(import.meta.url)) {
  try {
    const root = repoRoot();
    const rep = runHygiene(root);
    if (process.argv.includes('--json')) console.log(JSON.stringify(rep, null, 2));
    else {
      for (const e of rep.findings.error) console.log(`[错误] ${e}`);
      for (const w of rep.findings.warn) console.log(`[提示] ${w}`);
      console.log(rep.ok ? `巡检完成：错误 0，提示 ${rep.findings.warn.length}` : `巡检完成：错误 ${rep.findings.error.length}，提示 ${rep.findings.warn.length}`);
    }
    process.exit(rep.ok ? 0 : 1);
  } catch (e) {
    console.error(`巡检出错：${e.message}`);
    process.exit(1);
  }
}
