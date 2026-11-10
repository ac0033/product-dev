// 巡检（熵管理）：机械检查项目的目录、文件命名、索引、链接、状态、重复内容、超期草稿、已合并分支与残留工作树。
// 业务含义：项目越做越大，过时、重复、临时文件会悄悄积累。巡检只报告，不删除；删除文件须先列清单经用户确认。
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
      const ageDays = (Date.now() - fs.statSync(path.join(root, f)).mtimeMs) / 86400000;
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
  const status = git(root, ['status', '--porcelain', '-uall', '-z']);
  if (status.ok) {
    for (const { code, file: f } of parseStatusZ(status.out)) {
      const isRecord = layoutRecordDirs(hygiene).some((d) => f.startsWith(`${d}/`));
      if (isRecord && code.includes('M')) err(`记录类文档不得修改旧文件（请追加新文件）：${f}`);
    }
  }

  // 7. 已合并的分支与残留的工作树
  const branches = git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  const base = baseOrNull(root, cfg.base);
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

/** 记录类目录列表（配置里的 hygiene.recordDirs）。 */
function layoutRecordDirs(hygiene) {
  return hygiene.recordDirs || [];
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
