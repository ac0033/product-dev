// 只读汇总各 PR 的复审登记。collectMetrics 返回 prs、summary、badLines 和 skippedDirs。
// 每个 PR 含 pr、rounds、missedLater、accepts、closes、lastAt、dataMissing；占比以 0 到 1 表示。
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { gitCommonDir, isMain, repoRoot } from './lib.mjs';

function readLog(log, pr, badLines) {
  let text;
  try { text = fs.readFileSync(log, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const records = [];
  lines.forEach((line, i) => {
    try {
      const r = JSON.parse(line);
      if (!r?.kind || !r.verdict || !r.headSha || !Number.isFinite(Date.parse(r.at))) throw new Error('登记字段缺失或时间无效');
      records.push({ ...r, line: i + 1 });
    } catch (error) {
      badLines.push({ pr, line: i + 1, reason: error.message });
    }
  });
  return records;
}

function summarizePr(pr, records, lastAt) {
  const failedHeads = new Set();
  const row = { pr, rounds: 0, missedLater: 0, accepts: 0, closes: 0, lastAt, dataMissing: [] };
  let firstHead;
  for (const r of records) {
    if (r.kind === 'close') row.closes++;
    if (r.verdict === 'accept') row.accepts++;
    if (r.verdict !== 'fail') continue;
    failedHeads.add(r.headSha);
    firstHead ??= r.headSha;
    if (r.headSha === firstHead) continue;
    try {
      if (!r.data) throw new Error('登记缺少 data 路径');
      const data = JSON.parse(fs.readFileSync(r.data, 'utf8'));
      if (!Array.isArray(data?.findings)) throw new Error('数据副本缺少 findings 数组');
      row.missedLater += data.findings.filter((f) => f?.tag === '原先漏检').length;
    } catch (error) {
      row.dataMissing.push({ line: r.line, file: r.data ?? null, reason: error.message });
    }
  }
  row.rounds = failedHeads.size;
  return row;
}

/** 按最近登记时间选择 PR，保留其完整轮次历史；坏行与损坏的数据副本单列。 */
export function collectMetrics({ commonDir, now = Date.now(), sinceDays = null }) {
  const dir = path.join(commonDir, 'engineering-gate', 'pr');
  const cutoff = sinceDays === null ? -Infinity : new Date(now).getTime() - sinceDays * 86400000;
  const prs = [], badLines = [], skippedDirs = [];
  let firstPass = 0;
  const dirs = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [];
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    if (!/^\d+$/.test(entry.name)) {
      skippedDirs.push(entry.name);
      continue;
    }
    const records = readLog(path.join(dir, entry.name, 'log.jsonl'), entry.name, badLines);
    if (!records.length) continue;
    const lastAt = records.reduce((last, r) => Date.parse(r.at) > Date.parse(last) ? r.at : last, records[0].at);
    if (Date.parse(lastAt) < cutoff) continue;
    const row = summarizePr(entry.name, records, lastAt);
    prs.push(row);
    if (!row.rounds && records.some((r) => r.verdict === 'pass')) firstPass++;
  }
  prs.sort((a, b) => Number(a.pr) - Number(b.pr));
  const sum = (key) => prs.reduce((n, p) => n + p[key], 0);
  const summary = { prCount: prs.length, averageRounds: prs.length ? sum('rounds') / prs.length : 0,
    firstPassRate: prs.length ? firstPass / prs.length : 0, missedLater: sum('missedLater'), accepts: sum('accepts'), closes: sum('closes') };
  return { prs, summary, badLines, skippedDirs };
}

function table({ prs, summary: s, badLines, skippedDirs }) {
  const lines = [`共 ${s.prCount} 个 PR，平均失败轮次 ${s.averageRounds.toFixed(2)}，一轮通过 ${(100 * s.firstPassRate).toFixed(1)}%，后续发现原先漏检 ${s.missedLater} 条，接受风险 ${s.accepts} 次，收口 ${s.closes} 次`,
    'PR\t失败轮次\t后续漏检\t接受风险\t收口\t最后登记时间'];
  for (const p of prs) lines.push([p.pr, p.rounds, p.missedLater, p.accepts, p.closes, p.lastAt].join('\t'));
  for (const p of prs) for (const missing of p.dataMissing) lines.push(`PR ${p.pr} 第 ${missing.line} 行复审数据缺失：${missing.reason}`);
  for (const bad of badLines) lines.push(`PR ${bad.pr} 第 ${bad.line} 行登记损坏：${bad.reason}`);
  if (skippedDirs.length) lines.push(`跳过非数字目录：${skippedDirs.join('、')}`);
  return lines.join('\n');
}

if (isMain(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { since: { type: 'string' }, json: { type: 'boolean' } } });
    const sinceDays = values.since === undefined ? null : Number(values.since);
    if (sinceDays !== null && (!values.since.trim() || !Number.isFinite(sinceDays) || sinceDays < 0)) throw new Error('--since 须为非负天数');
    const result = collectMetrics({ commonDir: gitCommonDir(repoRoot()), sinceDays });
    console.log(values.json ? JSON.stringify(result) : table(result));
  } catch (error) {
    console.error(`复审指标读取失败：${error.message}`);
    process.exitCode = 1;
  }
}
