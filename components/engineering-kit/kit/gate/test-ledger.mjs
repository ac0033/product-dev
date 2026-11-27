// 测试台账：把 JUnit、测试命令和 CI 产物汇入 git 公共目录，按测试文件查看长期结果。
// buildReport 返回 empty 或各类文件、layers、commandLevel 和可选 untriggered。
// parseLcov 返回每个 file 的 lines / branches（各含 hit、total），coverageSummary 返回改动文件的 Markdown 表。
// 覆盖率另记为 ek-coverage/1 行（每个改动的源文件一行：file、lines、branches），与测试结果同存一份台账；报告的分类与层级只看测试行。
// pull 只接受与实际下载的运行对得上的 CI 行（source 为 ci、runId 以 ci-<运行号>-<attempt>- 开头、字段类型正确），其余拒绝并列出原因。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { normalizeConfig } from './config.mjs';
import { CONFIG_FILE, defaultGh, diffNames, git, gitCommonDir, headInfo, isMain, matchesAny, prNumber, repoRoot, runGh, withLock } from './lib.mjs';

const SCHEMA = 'ek-test-ledger/1';
const COVERAGE_SCHEMA = 'ek-coverage/1';
const UNKNOWN = '（未知文件）';
const DAY = 86400000;
const entities = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function fileName(value, root) {
  const slash = value.replaceAll('\\', '/');
  const paths = /^[a-z]:\/|^\/\//i.test(slash) ? path.win32 : path.posix;
  if (!paths.isAbsolute(slash)) return path.posix.normalize(slash);
  if (!paths.isAbsolute(root)) return value;
  const rel = paths.relative(root, slash).replaceAll('\\', '/');
  return rel === '..' || rel.startsWith('../') || paths.isAbsolute(rel) ? value : rel;
}

function owningFile(attrs, suite, root) {
  if (attrs.file || suite.file) return fileName(attrs.file || suite.file, root);
  const pythonFile = attrs.classname && attrs.classname.replaceAll('.', '/') + '.py';
  for (const guess of [suite.name, attrs.classname, pythonFile]) {
    if (!guess) continue;
    const rel = fileName(guess, root);
    if (path.win32.isAbsolute(rel) || rel === '..' || rel.startsWith('../')) continue;
    if (fs.statSync(path.resolve(root, rel), { throwIfNoEntry: false })?.isFile()) return rel;
  }
  return UNKNOWN;
}

function counters(file) {
  return { file, tests: 0, failures: 0, skipped: 0, durationMs: 0 };
}

/** 属性值里只许出现五种具名实体和数字引用；原始的 < 或不成引用的 & 说明报告本身坏了。 */
function decodeValue(raw) {
  if (raw.includes('<')) throw new Error('属性值里有未转义的 <');
  return raw.replace(/&([^;\s&<]*);?/g, (whole, body) => {
    if (!whole.endsWith(';')) throw new Error(`属性值里有不成引用的 &：${whole}`);
    if (Object.hasOwn(entities, body)) return entities[body];
    const num = /^#(?:x([0-9a-f]+)|(\d+))$/i.exec(body);
    const code = num ? parseInt(num[1] ?? num[2], num[1] ? 16 : 10) : NaN;
    if (!Number.isInteger(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Error(`属性值里有无效的实体：${whole}`);
    return String.fromCodePoint(code);
  });
}

function attributes(text) {
  const attrs = Object.create(null);
  const attr = /\s+([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
  let i = 0;
  while (i < text.trimEnd().length) {
    attr.lastIndex = i;
    const match = attr.exec(text);
    if (!match || Object.hasOwn(attrs, match[1])) throw new Error('元素属性格式错误或属性重复');
    attrs[match[1]] = decodeValue(match[2] ?? match[3]);
    i = attr.lastIndex;
  }
  return attrs;
}

/** 解析单份 JUnit XML，按文件合并测试数、失败数、跳过数和耗时；损坏报告返回原因。 */
export function parseJUnit(xml, { root = process.cwd() } = {}) {
  const files = new Map();
  const stack = [];
  let seenRoot = false;
  // 连续消费每个字符。带引号的属性、注释和 CDATA 中的尖括号都属于文字。
  const token = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[\w:.-]+(?:[^"'<>]|"[^"]*"|'[^']*')*>|[^<]+/gy;
  try {
    let offset = 0;
    while (offset < xml.length) {
      const match = token.exec(xml);
      if (!match) throw new Error('标签不完整');
      offset = token.lastIndex;
      const raw = match[0];
      if (raw.startsWith('<!--') || raw.startsWith('<?')) continue;
      if (!raw.startsWith('<') || raw.startsWith('<![CDATA[')) {
        if (!stack.length && raw.trim()) throw new Error('根元素外有文本');
        continue;
      }
      if (raw.startsWith('</')) {
        const end = /^<\/([\w:.-]+)\s*>$/.exec(raw);
        if (!end || stack.pop()?.name !== end[1]) throw new Error(`结束标签不配对：${raw}`);
        continue;
      }
      const [, name, rest, closed] = /^<([\w:.-]+)([\s\S]*?)(\/?)>$/.exec(raw);
      if (!stack.length) {
        if (seenRoot || !['testsuites', 'testsuite'].includes(name)) throw new Error('预期唯一的 testsuites 或 testsuite 根元素');
        seenRoot = true;
      }
      const attrs = attributes(rest);
      const parent = stack.at(-1);
      const suite = name === 'testsuite' ? attrs : parent?.suite ?? {};
      let current = parent?.current;
      if (name === 'testcase') {
        const file = owningFile(attrs, suite, root);
        if (!files.has(file)) files.set(file, counters(file));
        const counts = files.get(file);
        counts.tests++;
        const seconds = Number(attrs.time);
        if (Number.isFinite(seconds) && seconds >= 0) counts.durationMs += seconds * 1000;
        current = { counts, failed: Object.hasOwn(attrs, 'failure'), skipped: false };
        if (current.failed) counts.failures++;
      } else if (parent?.name === 'testcase') {
        if ((name === 'error' || name === 'failure') && !current.failed) {
          current.failed = true;
          current.counts.failures++;
        } else if (name === 'skipped' && !current.skipped) {
          current.skipped = true;
          current.counts.skipped++;
        }
      }
      if (!closed) stack.push({ name, suite, current });
    }
    if (stack.length || !seenRoot) throw new Error('没有根元素或标签未闭合');
    for (const counts of files.values()) counts.durationMs = Math.round(counts.durationMs);
    return { ok: true, files: [...files.values()] };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/** 取首个匹配测试文件的层名，命令级条目与未命中的文件使用“未分层”。 */
export function layerOf(file, testLayers = []) {
  return (file && testLayers.find((layer) => matchesAny(file, layer.paths))?.name) || '未分层';
}

/** 将同一次运行的报告汇成每文件一条；无法解析的报告另记命令级结果。 */
export function buildEntries({ reports, exitCode, source, commit, mode, os, changed, testLayers,
  testReportsConfigured, at, runId, root = process.cwd() }) {
  const common = { schema: SCHEMA, at, runId, source, commit, mode, os, changed };
  const command = (note) => ({ ...common, ...counters(null), layer: '未分层', result: exitCode === 0 ? 'pass' : 'fail', note });
  if (!testReportsConfigured) return [command('未配置 testReports')];
  if (!reports.length) return [command('未找到 JUnit 报告')];
  const entries = [];
  const files = new Map();
  for (const report of reports) {
    const parsed = parseJUnit(report.text, { root });
    if (!parsed.ok) {
      entries.push(command(`JUnit 解析失败：${report.path}：${parsed.error}`));
      continue;
    }
    for (const counts of parsed.files) {
      if (!files.has(counts.file)) files.set(counts.file, counters(counts.file));
      const total = files.get(counts.file);
      for (const key of ['tests', 'failures', 'skipped', 'durationMs']) total[key] += counts[key];
    }
  }
  for (const counts of files.values()) {
    const result = counts.failures ? 'fail' : counts.skipped === counts.tests ? 'skip' : 'pass';
    entries.push({ ...common, ...counts, layer: layerOf(counts.file, testLayers), result, note: null });
  }
  // 报告都解析成功却一个用例都没有：照样记一笔命令级结果，不让这次运行在台账里消失
  if (!files.size && !entries.length) return [command('JUnit 报告里没有用例')];
  // 命令失败而台账里没有任何失败（文件级没有失败、也没有命令级失败）：补一条，台账结果要与退出码一致；含全部跳过的文件也一样
  if (exitCode !== 0 && ![...files.values()].some((f) => f.failures) && !entries.some((e) => e.file === null && e.result === 'fail')) {
    entries.push(command('测试命令失败，但报告里没有失败用例'));
  }
  return entries;
}

/** 定位同一仓库所有工作树共享的台账。 */
export function ledgerFile(root) {
  return path.join(gitCommonDir(root), 'engineering-gate', 'test-ledger.jsonl');
}

/** 一次追加本批次的 JSON 行，自动创建父目录。 */
export function appendEntries(file, entries) {
  if (!entries.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, entries.map((e) => JSON.stringify(e) + '\n').join(''));
}

/** 读取台账（测试行与覆盖率行），另列 JSON 或 schema 不合法的物理行号。 */
export function readLedger(file) {
  const entries = [], bad = [];
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return { entries, bad };
    throw error;
  }
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  lines.forEach((line, i) => {
    try {
      const entry = JSON.parse(line);
      if (entry?.schema === SCHEMA || entry?.schema === COVERAGE_SCHEMA) entries.push(entry);
      else bad.push(i + 1);
    } catch { bad.push(i + 1); }
  });
  return { entries, bad };
}

/** 按种类、runId、来源、文件和说明过滤已存在及本批重复的条目（同一次运行的几条命令级诊断 file 都是 null，靠说明区分）。 */
export function mergeEntries(existing, incoming) {
  const key = (entry) => JSON.stringify([entry.schema ?? SCHEMA, entry.runId, entry.source, entry.file, entry.note ?? null]);
  const seen = new Set(existing.map(key));
  return incoming.filter((entry) => {
    const id = key(entry);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** 统计窗口内的文件结果与层级失败率，长期未触发按全部历史的最近时间判断。 */
export function buildReport(entries, { now = Date.now(), sinceDays = null, staleDays = 30, testFiles = null } = {}) {
  const time = new Date(now).getTime();
  const tests = entries.filter((e) => (e.schema ?? SCHEMA) === SCHEMA);
  const inWindow = (e) => sinceDays === null || Date.parse(e.at) >= time - sinceDays * DAY;
  const coverageRows = entries.filter((e) => e.schema === COVERAGE_SCHEMA && inWindow(e));
  const recent = tests.filter(inWindow);
  if (!recent.length && !coverageRows.length && testFiles === null) return { empty: true };
  const byFile = new Map(), byLayer = new Map();
  const commandLevel = { count: 0, notes: Object.create(null) };
  for (const { file, layer, result, note } of recent) {
    if (file === null) {
      commandLevel.count++;
      commandLevel.notes[note] = (commandLevel.notes[note] ?? 0) + 1;
      continue;
    }
    if (file === UNKNOWN) continue;
    if (!byFile.has(file)) byFile.set(file, { file, pass: 0, fail: 0, skip: 0 });
    byFile.get(file)[result]++;
    if (!byLayer.has(layer)) byLayer.set(layer, { name: layer, files: new Set(), runs: 0, failures: 0 });
    const group = byLayer.get(layer);
    group.files.add(file);
    group.runs++;
    if (result === 'fail') group.failures++;
  }
  const files = [...byFile.values()];
  const layers = [...byLayer.values()].map((l) => ({ ...l, files: l.files.size, failureRate: l.failures / l.runs }));
  const report = { count: recent.length, alwaysPass: files.filter((f) => f.pass && !f.fail && !f.skip).map((f) => f.file),
    alwaysFail: files.filter((f) => f.fail && !f.pass && !f.skip).map((f) => f.file),
    flaky: files.filter((f) => f.pass && f.fail), layers, commandLevel, windowEmpty: !recent.length };
  if (testFiles !== null) {
    // 长期未运行按全部历史算，不受时间窗口限制：窗口里没有记录时也照样列出
    const active = new Set(tests.filter((e) => Date.parse(e.at) >= time - staleDays * DAY).map((e) => e.file));
    report.untriggered = testFiles.filter((file) => !active.has(file));
  }
  const latest = new Map();
  for (const row of coverageRows) if (!latest.has(row.file) || Date.parse(row.at) >= Date.parse(latest.get(row.file).at)) latest.set(row.file, row);
  report.coverage = [...latest.values()].sort((a, b) => a.file.localeCompare(b.file));
  return report;
}

/** 将分类、层级计数和命令级原因输出为中文多行文本。 */
export function formatReport(report) {
  if (report.empty) return '台账里还没有数据';
  const lines = [report.windowEmpty ? '所选时间窗口内没有测试记录' : `测试台账共 ${report.count} 条测试记录`];
  const section = (name, rows) => lines.push(name, ...(rows.length ? rows.map((r) => '  ' + r) : ['  无']));
  section('一直通过', report.alwaysPass);
  section('一直失败', report.alwaysFail);
  section('时过时不过', report.flaky.map((f) => `${f.file}（通过 ${f.pass} 次、失败 ${f.fail} 次）`));
  section('各层测试', report.layers.map((l) => `${l.name}：${l.files} 个文件，运行 ${l.runs} 次，失败 ${l.failures} 次，失败率 ${(l.failureRate * 100).toFixed(1)}%`));
  if (report.untriggered) section('长期未运行', report.untriggered);
  const pct = ({ hit, total }) => (total ? `${((100 * hit) / total).toFixed(1)}%（${hit}/${total}）` : '—');
  if (report.coverage.length) section('覆盖率（各文件最近一次）', report.coverage.map((c) => `${c.file}：行 ${pct(c.lines)}，分支 ${pct(c.branches)}`));
  section(`命令级记录 ${report.commandLevel.count} 条`, Object.entries(report.commandLevel.notes).map(([note, n]) => `${note}：${n} 条`));
  return lines.join('\n');
}

/** 合并不同 lcov 记录中相同文件的行号与分支编号；任一次命中就算覆盖。 */
export function parseLcov(text, { root = process.cwd() } = {}) {
  const files = new Map();
  let current;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      const file = fileName(line.slice(3), root);
      if (!files.has(file)) files.set(file, { lines: new Map(), branches: new Map() });
      current = files.get(file);
    } else if (line === 'end_of_record') {
      current = null;
    } else if (current && line.startsWith('DA:')) {
      const [number, hits] = line.slice(3).split(',');
      current.lines.set(number, current.lines.get(number) || Number(hits) > 0);
    } else if (current && line.startsWith('BRDA:')) {
      const [lineNo, block, branch, taken] = line.slice(5).split(',');
      const key = [lineNo, block, branch].join(',');
      current.branches.set(key, current.branches.get(key) || Number(taken) > 0);
    }
  }
  const count = (map) => ({ hit: [...map.values()].filter(Boolean).length, total: map.size });
  return [...files].map(([file, counts]) => ({ file, lines: count(counts.lines), branches: count(counts.branches) }));
}

/** 输出改动文件的行与分支覆盖率，没有可统计分母时显示破折号。 */
export function coverageSummary(files, changed) {
  const wanted = new Set(changed);
  const selected = files.filter((item) => wanted.has(item.file));
  if (!selected.length) return '本次改动的文件没有覆盖率数据';
  const rate = ({ hit, total }) => total ? `${(100 * hit / total).toFixed(1)}% (${hit}/${total})` : '—';
  return ['| 文件 | 行覆盖率 | 分支覆盖率 |', '| --- | ---: | ---: |',
    ...selected.map((f) => `| ${f.file.replaceAll('|', '\\|').replace(/[\r\n]/g, ' ')} | ${rate(f.lines)} | ${rate(f.branches)} |`)].join('\n');
}

/** 收集与 glob 或字面路径匹配的 JUnit 文件。闸门可用 startedAt 排除旧报告。 */
export function readReports(root, patterns, startedAt = -Infinity) {
  const files = new Set();
  for (const pattern of patterns) {
    const normalized = pattern.replaceAll('\\', '/');
    const candidates = /[*?[\]{}]|[!+@]\(/.test(normalized) ? fs.globSync(normalized, { cwd: root }) : [normalized];
    for (const candidate of candidates) {
      const file = path.resolve(root, candidate);
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (stat?.isFile() && stat.mtimeMs >= startedAt) files.add(file);
    }
  }
  return [...files].sort().map((file) => ({ path: file, text: fs.readFileSync(file, 'utf8') }));
}

/** 记录一次实际运行，返回条目供调用方显示计数。 */
export function recordTests({ root, config, patterns = config.testReports, startedAt, exitCode, source = 'local',
  commit, mode = 'full', os: system = { linux: 'linux', win32: 'windows', darwin: 'macos' }[process.platform] ?? null,
  changed = [], runId, out }) {
  const defaultId = source === 'ci' && process.env.GITHUB_RUN_ID
    ? `ci-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? 1}-${system}` : `${source}-${randomUUID()}`;
  const entries = buildEntries({ root, reports: readReports(root, patterns, startedAt), testReportsConfigured: patterns.length > 0,
    testLayers: config.testLayers, exitCode, source, commit: commit === undefined ? headInfo(root).headSha : commit, mode,
    os: system, changed, at: new Date().toISOString(), runId: runId ?? defaultId });
  appendEntries(out ?? ledgerFile(root), entries);
  return entries;
}

/** 取两个修订之间的改动文件；git 出错时显式报告原因。 */
export function changedBetween(root, base, commit = 'HEAD') {
  if (!base || base.startsWith('-') || !commit || commit.startsWith('-')) throw new Error('缺少或无效的比较修订');
  const diff = diffNames(root, [base, commit, '--']);
  if (!diff.ok) throw new Error(`读取改动文件失败：${diff.err.trim()}`);
  return diff.files;
}

/** 从 PR 最终提交的已完成运行下载指定产物，文件仅在回调 consume(dir, run) 内有效（run 是 gh run list 的那一项）；缺失产物与 gh 错误分别处理。 */
export function readRunArtifacts({ root, pr, artifact, prefix = false, gh = defaultGh }, consume) {
  const view = JSON.parse(runGh(gh, ['pr', 'view', prNumber(pr), '--json', 'headRefOid'], root));
  if (!/^[0-9a-f]{40}$/i.test(view.headRefOid)) throw new Error('gh 没有返回有效的 PR 最终提交');
  const runs = JSON.parse(runGh(gh, ['run', 'list', '--commit', view.headRefOid, '--json', 'databaseId,attempt,status,conclusion,name'], root));
  const downloaded = [], missing = [];
  for (const run of runs.filter((r) => r.status === 'completed')) {
    const id = String(run.databaseId);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ek-artifact-'));
    try {
      try {
        runGh(gh, ['run', 'download', id, ...(prefix ? ['--pattern', artifact + '*'] : ['--name', artifact]), '--dir', dir], root);
      } catch (error) {
        if (!/no (?:valid |matching )?artifacts? (?:found|match)|no artifacts? (?:was |were )?downloaded/i.test(error.message)) throw error;
        missing.push(id);
        continue;
      }
      consume(dir, run);
      downloaded.push(id);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return { downloaded, missing, runs };
}

const isCount = (v) => Number.isFinite(v) && v >= 0;
const isRatio = (v) => v !== null && typeof v === 'object' && isCount(v.hit) && isCount(v.total) && v.hit <= v.total;

/**
 * 产物里的一行能不能进本机台账：产物来自 PR 上的 CI，内容可以被 PR 改写，所以只认与实际下载的运行对得上的 CI 行，
 * 不认产物自报的来源。返回拒绝原因，合格返回 null。
 */
export function importProblem(entry, run) {
  if (entry.source !== 'ci') return `来源不是 ci（${entry.source}）`;
  const prefix = `ci-${run.databaseId}-${run.attempt ?? 1}-`;
  if (typeof entry.runId !== 'string' || !entry.runId.startsWith(prefix)) return `runId ${entry.runId} 不属于下载它的运行（应以 ${prefix} 开头）`;
  if (!Number.isFinite(Date.parse(entry.at))) return `时间不可解析（${entry.at}）`;
  if (entry.schema === COVERAGE_SCHEMA) {
    if (typeof entry.file !== 'string' || !entry.file) return '覆盖率行缺文件名';
    if (!isRatio(entry.lines) || !isRatio(entry.branches)) return '覆盖率行的 lines 或 branches 不是 { hit, total }';
    return null;
  }
  if (entry.file !== null && (typeof entry.file !== 'string' || !entry.file)) return `file 不是字符串或 null（${JSON.stringify(entry.file)}）`;
  if (!['pass', 'fail', 'skip'].includes(entry.result)) return `结果不合法（${entry.result}）`;
  for (const k of ['tests', 'failures', 'skipped', 'durationMs']) if (!isCount(entry[k])) return `${k} 不是非负数（${JSON.stringify(entry[k])}）`;
  return null;
}

function pullLedger(root, pr, artifact) {
  const incoming = [];
  const rejected = [];
  const { downloaded, missing } = readRunArtifacts({ root, pr, artifact, prefix: true }, (dir, run) => {
    for (const file of fs.globSync('**/*.jsonl', { cwd: dir })) {
      for (const entry of readLedger(path.join(dir, file)).entries) {
        const why = importProblem(entry, run);
        if (why) rejected.push(`运行 ${run.databaseId}：${why}`);
        else incoming.push(entry);
      }
    }
  });
  const file = ledgerFile(root);
  const count = withLock(root, 'test-ledger-pull', () => {
    const fresh = mergeEntries(readLedger(file).entries, incoming);
    appendEntries(file, fresh);
    return fresh.length;
  });
  console.log(`拉回运行 ${downloaded.join('、') || '无'}；缺少产物的运行 ${missing.join('、') || '无'}；新增 ${count} 条，跳过重复 ${incoming.length - count} 条${rejected.length ? `，拒绝 ${rejected.length} 条（与下载的运行对不上或字段不合法，未写入）` : ''}`);
  for (const why of rejected) console.log(`  拒绝：${why}`);
}

/** 本地没有工程配置时使用默认值，允许独立采集已有的 CI 报告。 */
export function metricsConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  return normalizeConfig(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});
}

function options(args, names) {
  return parseArgs({ args, options: Object.fromEntries(names.map((name) => [name, { type: 'string', multiple: name === 'junit' }])) }).values;
}

function days(value, fallback) {
  if (value === undefined) return fallback;
  if (!value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0) throw new Error(`天数须为非负数：${value}`);
  return Number(value);
}

/** 巡检用的层级提示：没配 testLayers 时提示补配；已跟踪文件命中多个层级时列出文件、命中的层和实际采用的层（第一个）。 */
function layerHints(root, config) {
  if (!config.testLayers.length) return ['提示：未配置 modules.gate.testLayers，台账层级一律记“未分层”；在项目配置里按 unit、integration、e2e 等声明后可按层统计'];
  const tracked = git(root, ['ls-files', '-z']);
  if (!tracked.ok) return [];
  const overlaps = [];
  for (const file of tracked.out.split(' ').filter(Boolean)) {
    const hit = config.testLayers.filter((layer) => matchesAny(file, layer.paths)).map((layer) => layer.name);
    if (hit.length > 1) overlaps.push(`  ${file}：命中 ${hit.join('、')}，采用 ${hit[0]}`);
  }
  return overlaps.length ? ['提示：以下测试文件命中多个层级，按配置顺序取第一个：', ...overlaps] : [];
}

function main([command, ...args]) {
  const root = repoRoot();
  if (command === 'record') {
    const v = options(args, ['exit-code', 'source', 'junit', 'mode', 'commit', 'os', 'run-id', 'changed-from', 'out']);
    if (!/^-?\d+$/.test(v['exit-code'])) throw new Error('--exit-code 须为整数');
    if (v.source !== undefined && !['local', 'ci'].includes(v.source)) throw new Error('--source 须为 local 或 ci');
    if (v.mode !== undefined && !['full', 'affected'].includes(v.mode)) throw new Error('--mode 须为 full 或 affected');
    if (v.os !== undefined && !['linux', 'windows', 'macos'].includes(v.os)) throw new Error('--os 须为 linux、windows 或 macos');
    if (v.commit !== undefined && !/^[a-f0-9]{40}$/i.test(v.commit)) throw new Error('--commit 须为 40 位提交号');
    const commit = v.commit ?? headInfo(root).headSha;
    const changed = v['changed-from'] === undefined ? [] : changedBetween(root, v['changed-from'], commit);
    recordTests({ root, config: metricsConfig(root), patterns: v.junit, exitCode: Number(v['exit-code']), commit, changed,
      source: v.source, os: v.os, mode: v.mode, runId: v['run-id'], out: v.out });
  } else if (command === 'pull') {
    const v = options(args, ['pr', 'artifact']);
    pullLedger(root, v.pr, v.artifact ?? 'test-ledger');
  } else if (command === 'report') {
    const v = options(args, ['ledger', 'since', 'stale-days']);
    const { entries, bad } = readLedger(v.ledger ?? ledgerFile(root));
    const config = metricsConfig(root);
    let testFiles = null;
    if (config.testGlobs.length) {
      const tracked = git(root, ['ls-files', '-z']);
      if (!tracked.ok) throw new Error(`读取已跟踪测试文件失败：${tracked.err}`);
      testFiles = [...new Set(tracked.out.split('\0').filter((f) => f && matchesAny(f, config.testGlobs)))];
    }
    if (bad.length) console.log(`跳过 ${bad.length} 行坏行（行号 ${bad.join('、')}）`);
    for (const line of layerHints(root, config)) console.log(line);
    console.log(formatReport(buildReport(entries, { sinceDays: days(v.since, null), staleDays: days(v['stale-days'], 30), testFiles })));
  } else if (command === 'coverage') {
    const v = options(args, ['lcov', 'base', 'summary', 'out', 'run-id', 'os']);
    if (v.os !== undefined && !['linux', 'windows', 'macos'].includes(v.os)) throw new Error('--os 须为 linux、windows 或 macos');
    if (!v.lcov || !v.base || !v.summary) throw new Error('coverage 需要 --lcov、--base 和 --summary');
    const files = parseLcov(fs.readFileSync(v.lcov, 'utf8'), { root });
    const changed = changedBetween(root, v.base);
    const report = coverageSummary(files, changed);
    fs.appendFileSync(v.summary, report + '\n');
    console.log(report);
    if (v.out) {
      // 覆盖率进台账：每个改动的源文件一行，供 pull 拉回后在报告里看趋势
      const wanted = new Set(changed);
      const at = new Date().toISOString();
      const runId = v['run-id'] ?? `ci-${randomUUID()}`;
      const { headSha } = headInfo(root);
      appendEntries(v.out, files.filter((f) => wanted.has(f.file)).map((f) => ({ schema: COVERAGE_SCHEMA, at, runId, source: 'ci', commit: headSha, os: v.os ?? null, file: f.file, lines: f.lines, branches: f.branches })));
    }
  } else throw new Error('命令须为 record、pull、report 或 coverage');
}

if (isMain(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error(`测试台账操作失败：${error.message}`);
    process.exitCode = 1;
  }
}
