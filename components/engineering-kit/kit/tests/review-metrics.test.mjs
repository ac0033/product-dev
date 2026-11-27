// 复审质量指标测试（规格 spec-CD 第 4 节，场景 C8）：只读 <git 公共目录>/engineering-gate/pr/<编号>/log.jsonl 与登记里指向的复审数据副本，
// 统计每个 PR 的复审轮次、后续轮次才发现的“原先漏检”、通过与关闭次数，并汇总。业务含义：这是衡量复审质量的度量，不能因为个别坏数据中断，
// 也不能改动任何登记。log 里的字段沿用 review.mjs 的 PR 登记：kind、verdict、headSha、at、可选 data（复审数据副本的绝对路径）。
// 规格没写死返回值里“PR 列表”和“汇总”的键名，所以按“带 lastAt 的对象是单个 PR、其余带 missedLater 的对象是汇总”识别。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commitAll, git, tmpDir, tmpRepo, write } from './helpers.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'gate', 'review-metrics.mjs');
const NOW = '2026-11-27T00:00:00.000Z';
const DAY = 86400000;
const ago = (days) => new Date(Date.parse(NOW) - days * DAY).toISOString();

/** 建仓库并返回 git 公共目录（登记日志放在它下面的 engineering-gate/pr/）。 */
function repo() {
  const root = tmpRepo();
  write(root, 'README.md', 'x\n');
  commitAll(root, 'base');
  return { root, commonDir: path.resolve(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()) };
}

/** 写一份复审数据副本，findings 的 tag 按给定列表；返回绝对路径。 */
function dataFile(tags) {
  const p = path.join(tmpDir('ekit-metric-'), 'review.json');
  const findings = tags.map((tag, i) => ({ id: `M${i + 1}`, severity: 'medium', tag, location: 'src/a.mjs:1', problem: 'p', trigger: 't', reason: 'r', fix: 'f' }));
  fs.writeFileSync(p, JSON.stringify({ format: 'ek-review/1', kind: 'code', verdict: 'fail', findings }));
  return p;
}

/** 写某个 PR 的 log.jsonl（records 是对象数组，字符串原样写成一行，用来造坏行）。 */
function writeLog(commonDir, pr, records) {
  const dir = path.join(commonDir, 'engineering-gate', 'pr', String(pr));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'log.jsonl'), records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
}

const rec = (over) => ({ kind: 'code', verdict: 'fail', headSha: 'a'.repeat(40), at: ago(1), ...over });
const sha = (c) => c.repeat(40);

/** 在返回值里找出各 PR 的对象（带 lastAt）和汇总对象（带 missedLater 但不带 lastAt）。 */
function split(result) {
  const prs = [];
  const sums = [];
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (!Array.isArray(v) && 'missedLater' in v) (('lastAt' in v) ? prs : sums).push(v);
    for (const x of Object.values(v)) walk(x);
  };
  walk(result);
  return { prs, summary: sums[0] };
}

/** 三个 PR：A 一次通过（0 次失败）；B 失败两轮后通过、第二轮有 2 条原先漏检；C 失败四轮、第 2 轮 1 条第 3 轮 3 条原先漏检、第 1 轮的漏检标签不计，关闭 1 次，登记接受 2 次。 */
function seed(commonDir) {
  writeLog(commonDir, 1, [rec({ kind: 'code', verdict: 'pass', headSha: sha('1'), at: ago(5) })]);
  writeLog(commonDir, 2, [
    rec({ verdict: 'fail', headSha: sha('2'), at: ago(6), data: dataFile(['原先漏检', '新发现']) }),
    rec({ verdict: 'fail', headSha: sha('3'), at: ago(4), data: dataFile(['原先漏检', '原先漏检', '新发现']) }),
    rec({ verdict: 'pass', headSha: sha('4'), at: ago(3.5) }),
  ]);
  writeLog(commonDir, 3, [
    rec({ verdict: 'fail', headSha: sha('5'), at: ago(9) }),
    rec({ verdict: 'fail', headSha: sha('5'), at: ago(8) }),
    rec({ verdict: 'fail', headSha: sha('6'), at: ago(7), data: dataFile(['原先漏检']) }),
    rec({ verdict: 'fail', headSha: sha('7'), at: ago(6), data: dataFile(['原先漏检', '原先漏检', '原先漏检']) }),
    rec({ verdict: 'fail', headSha: sha('8'), at: ago(2), data: dataFile([]) }),
    rec({ verdict: 'accept', headSha: sha('8'), at: ago(2) }),
    rec({ verdict: 'accept', headSha: sha('8'), at: ago(1) }),
    rec({ kind: 'close', verdict: 'close', headSha: sha('8'), at: ago(1) }),
  ]);
}

test('C8 指标：每个 PR 的 rounds（登记过 fail 的不同 headSha 数）、missedLater（第 2 轮起的原先漏检条数）、accepts、closes、lastAt', async () => {
  const { collectMetrics } = await import('../gate/review-metrics.mjs');
  const { commonDir } = repo();
  seed(commonDir);
  const { prs } = split(collectMetrics({ commonDir, now: NOW, sinceDays: null }));
  assert.equal(prs.length, 3, JSON.stringify(prs));
  const view = (p) => [p.rounds, p.missedLater, p.accepts, p.closes];
  const found = prs.map(view).sort();
  // PR1：0 轮；PR2：2 轮，第 2 轮 2 条；PR3：4 个不同 headSha（同一 sha 的重复登记只算一轮），第 2 轮起 1 + 3 + 0 条（第 1 轮的数据副本不读）
  assert.deepEqual(found, [[0, 0, 0, 0], [2, 2, 0, 0], [4, 4, 2, 1]].sort());
  const c = prs.find((p) => p.rounds === 4);
  assert.equal(new Date(c.lastAt).toISOString(), ago(1), 'lastAt 是最后一次登记的时间');
});

test('C8 指标：汇总——PR 数、平均轮次、missedLater / accepts / closes 合计', async () => {
  const { collectMetrics } = await import('../gate/review-metrics.mjs');
  const { commonDir } = repo();
  seed(commonDir);
  const { summary } = split(collectMetrics({ commonDir, now: NOW, sinceDays: null }));
  assert.ok(summary, '要有汇总对象');
  assert.deepEqual([summary.missedLater, summary.accepts, summary.closes], [6, 2, 1]);
  const nums = Object.values(summary).filter((v) => typeof v === 'number');
  assert.ok(nums.includes(3), `PR 数 3：${JSON.stringify(summary)}`);
  assert.ok(nums.includes(2), `平均轮次 (0+2+4)/3 = 2：${JSON.stringify(summary)}`);
});

test('C8 指标：第 2 轮起的复审数据读不到（路径不存在、不是合法 JSON）→ 记进 dataMissing，不中断，其余照算', async () => {
  const { collectMetrics } = await import('../gate/review-metrics.mjs');
  const { commonDir } = repo();
  const broken = path.join(tmpDir('ekit-metric-'), 'broken.json');
  fs.writeFileSync(broken, '{not json');
  writeLog(commonDir, 5, [
    rec({ headSha: sha('a'), at: ago(4) }),
    rec({ headSha: sha('b'), at: ago(3), data: path.join(tmpDir('ekit-metric-'), 'gone.json') }),
    rec({ headSha: sha('c'), at: ago(2), data: broken }),
    rec({ headSha: sha('d'), at: ago(1), data: dataFile(['原先漏检']) }),
  ]);
  const result = collectMetrics({ commonDir, now: NOW, sinceDays: null });
  const { prs } = split(result);
  assert.equal(prs.length, 1);
  assert.equal(prs[0].rounds, 4);
  assert.equal(prs[0].missedLater, 1, '读得到的照算');
  assert.ok('dataMissing' in prs[0], JSON.stringify(prs[0]));
  const missing = prs[0].dataMissing;
  assert.ok((Array.isArray(missing) ? missing.length : missing) === 2, `两份读不到：${JSON.stringify(missing)}`);
});

test('C8 指标：日志坏行、目录名不是数字的跳过并单列，不中断', async () => {
  const { collectMetrics } = await import('../gate/review-metrics.mjs');
  const { commonDir } = repo();
  writeLog(commonDir, 8, [rec({ headSha: sha('a') }), 'this is not json', rec({ headSha: sha('b') })]);
  writeLog(commonDir, 'not-a-number', [rec({ headSha: sha('c') })]);
  const result = collectMetrics({ commonDir, now: NOW, sinceDays: null });
  const { prs } = split(result);
  assert.equal(prs.length, 1, '数字目录只有 8 一个');
  assert.equal(prs[0].rounds, 2, '坏行之外的两行照算');
  const text = JSON.stringify(result);
  assert.ok(text.includes('not-a-number'), '目录名不是数字的单列');
});

test('C8 指标：--since 按 lastAt 过滤', async () => {
  const { collectMetrics } = await import('../gate/review-metrics.mjs');
  const { commonDir } = repo();
  seed(commonDir);
  writeLog(commonDir, 9, [rec({ verdict: 'pass', headSha: sha('9'), at: ago(60) })]);
  assert.equal(split(collectMetrics({ commonDir, now: NOW, sinceDays: null })).prs.length, 4);
  assert.equal(split(collectMetrics({ commonDir, now: NOW, sinceDays: 30 })).prs.length, 3, '60 天前的 PR 被过滤');
  assert.equal(split(collectMetrics({ commonDir, now: NOW, sinceDays: 3 })).prs.length, 1, '只剩 lastAt 在 3 天内的（PR 3，1 天前）');
});

test('C8 指标：没有任何登记目录 → 空结果不报错；采集只读，不改动日志', async () => {
  const { collectMetrics } = await import('../gate/review-metrics.mjs');
  const { commonDir } = repo();
  assert.equal(split(collectMetrics({ commonDir, now: NOW, sinceDays: null })).prs.length, 0);
  seed(commonDir);
  const file = path.join(commonDir, 'engineering-gate', 'pr', '3', 'log.jsonl');
  const before = fs.readFileSync(file, 'utf8');
  collectMetrics({ commonDir, now: NOW, sinceDays: null });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('C8 命令行：缺省输出中文表格；--json 输出可解析的 JSON；--since 生效；退出码 0', () => {
  const { root, commonDir } = repo();
  seed(commonDir);
  const table = spawnSync(process.execPath, [CLI], { cwd: root, encoding: 'utf8' });
  assert.equal(table.status, 0, table.stderr);
  assert.ok(/[一-鿿]/.test(table.stdout), '中文表格');
  assert.throws(() => JSON.parse(table.stdout), undefined, '缺省输出不是 JSON');
  const json = spawnSync(process.execPath, [CLI, '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.equal(split(parsed).prs.length, 3);
  assert.equal(split(parsed).summary.missedLater, 6);
});

// ---------- 首轮复审回归（M8） ----------

/** 返回值里除 prs、summary、badLines、skippedDirs 之外，是否有某个数组同时含有全部给定的 PR 编号（视为“缺失/不可用”列表）。 */
function unavailableListHolds(result, prNumbers) {
  const skip = new Set(['prs', 'summary', 'badLines', 'skippedDirs']);
  let found = false;
  const walk = (v) => {
    if (!v || typeof v !== 'object' || found) return;
    if (Array.isArray(v) && prNumbers.every((n) => v.some((x) => JSON.stringify(x).includes(String(n))))) found = true;
    for (const x of Object.values(v)) walk(x);
  };
  for (const [k, v] of Object.entries(result)) if (!skip.has(k)) walk(v);
  return found;
}

/** 数字目录但 log.jsonl 读取抛错：把 log.jsonl 建成目录。 */
function unreadableLog(commonDir, pr) {
  fs.mkdirSync(path.join(commonDir, 'engineering-gate', 'pr', String(pr), 'log.jsonl'), { recursive: true });
}

test('M8 指标：数字目录下没有 log.jsonl 的 PR 单列，不计入 prs', async () => {
  const { collectMetrics } = await import('../gate/review-metrics.mjs');
  const { commonDir } = repo();
  writeLog(commonDir, 1, [rec({ verdict: 'pass', headSha: sha('1') })]);
  fs.mkdirSync(path.join(commonDir, 'engineering-gate', 'pr', '7731'), { recursive: true });
  const result = collectMetrics({ commonDir, now: NOW, sinceDays: null });
  const { prs, summary } = split(result);
  assert.deepEqual(prs.map((p) => p.pr), ['1']);
  assert.equal(summary.prCount, 1);
  assert.ok(unavailableListHolds(result, [7731]), `返回值里要有列出 7731 的缺失列表：${JSON.stringify(result)}`);
});

test('M8 指标：某个 PR 的日志读取抛错时，其他 PR 仍正常汇总、该 PR 单列', async () => {
  const { collectMetrics } = await import('../gate/review-metrics.mjs');
  const { commonDir } = repo();
  seed(commonDir);
  unreadableLog(commonDir, 7732);
  const result = collectMetrics({ commonDir, now: NOW, sinceDays: null });
  const { prs, summary } = split(result);
  assert.equal(prs.length, 3, '种子里的 3 个 PR 照常');
  assert.ok(!prs.some((p) => String(p.pr) === '7732'));
  assert.deepEqual([summary.missedLater, summary.accepts, summary.closes], [6, 2, 1]);
  assert.ok(unavailableListHolds(result, [7732]), JSON.stringify(result));
});

test('M8 指标：只有坏行的 PR 也和缺失、不可读的 PR 一起单列，不计入 prs', async () => {
  const { collectMetrics } = await import('../gate/review-metrics.mjs');
  const { commonDir } = repo();
  writeLog(commonDir, 1, [rec({ verdict: 'pass', headSha: sha('1') })]);
  fs.mkdirSync(path.join(commonDir, 'engineering-gate', 'pr', '7731'), { recursive: true });
  unreadableLog(commonDir, 7732);
  writeLog(commonDir, 7733, ['garbage', '{also bad']);
  const result = collectMetrics({ commonDir, now: NOW, sinceDays: null });
  const { prs } = split(result);
  assert.deepEqual(prs.map((p) => p.pr), ['1']);
  assert.ok(unavailableListHolds(result, [7731, 7732, 7733]), JSON.stringify(result));
});

// ---------- 第 2 轮复审回归（规格第 10 节：登记行字段校验 M7） ----------

test('R2-7 指标：kind、verdict、headSha 值不合法的行归入 badLines；只有这类行的 PR 进入不可用列表、不计入 prs，其余 PR 不受影响', async () => {
  const { collectMetrics } = await import('../gate/review-metrics.mjs');
  const { commonDir } = repo();
  seed(commonDir);
  writeLog(commonDir, 7741, [rec({ kind: 'weird', headSha: sha('1') })]);
  writeLog(commonDir, 7742, [rec({ verdict: 'maybe', headSha: sha('2') })]);
  writeLog(commonDir, 7743, [rec({ headSha: 'xyz' }), rec({ headSha: 'a'.repeat(39) })]);
  writeLog(commonDir, 7744, [rec({ kind: 'consistency', verdict: 'defer', headSha: 'b'.repeat(64) }), rec({ verdict: 'accept', headSha: sha('c') })]);
  writeLog(commonDir, 7745, [rec({ headSha: sha('d') }), rec({ kind: 'weird', headSha: sha('e') })]);
  const result = collectMetrics({ commonDir, now: NOW, sinceDays: null });
  const { prs, summary } = split(result);
  const listed = prs.map((p) => String(p.pr));
  for (const bad of ['7741', '7742', '7743']) assert.ok(!listed.includes(bad), `${bad} 只有不合法的行：不计入 prs`);
  for (const good of ['1', '2', '3', '7744', '7745']) assert.ok(listed.includes(good), `${good} 照常汇总：${listed}`);
  assert.equal(summary.prCount, 5);
  assert.ok(unavailableListHolds(result, [7741, 7742, 7743]), JSON.stringify(result));
  assert.ok(!unavailableListHolds(result, [7744]) && !unavailableListHolds(result, [7745]), '有合法行的 PR 不进不可用列表');
  const bad = JSON.stringify(result.badLines);
  assert.ok(bad && bad !== '[]' && bad !== '{}' && bad !== 'null', 'badLines 里要有这些行');
});
