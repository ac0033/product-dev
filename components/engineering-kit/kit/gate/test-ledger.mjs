// 测试台账：闸门每次真正跑了测试，就把 JUnit 报告（或整条测试命令的结果）按测试文件记进 git 公共目录的台账，供巡检看长期结果。
// 行格式 ek-test-ledger/1（字段见 readLedger 的校验）。buildReport 返回 { empty: true }，或 alwaysPass、alwaysFail、flaky、
// layers、commandLevel、windowEmpty 和可选的 untriggered；formatReport 把它写成中文多行文本。
// 只报告、不拦截：写台账失败由调用方降为警告。CI 产物的拉回、覆盖率与变异测试在后续版本另做（见 PR #47 的范围说明）。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { normalizeConfig } from './config.mjs';
import { CONFIG_FILE, diffNames, git, gitCommonDir, headInfo, isMain, matchesAny, repoRoot, withLock } from './lib.mjs';

const SCHEMA = 'ek-test-ledger/1';
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

/** XML 1.0 允许的字符：#x9、#xA、#xD、#x20–#xD7FF、#xE000–#xFFFD、#x10000–#x10FFFF。 */
function isXmlChar(code) {
  return code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
}

/** 原文里的每个字符都要是 XML 字符（单独的代理项、控制字符、U+FFFE/FFFF 都说明报告坏了）。 */
function checkChars(raw, where) {
  for (const ch of raw) {
    const code = ch.codePointAt(0);
    if (!isXmlChar(code) || (code >= 0xd800 && code <= 0xdfff)) throw new Error(`${where}里有不合法的 XML 字符 U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
  }
}

/**
 * 解码属性值或正文里的引用：只许五种具名实体和数字引用（十六进制前缀只许小写 x，码点须是 XML 字符）；
 * 原始的 <、不成引用的 & 和不合法的字符都说明报告本身坏了。
 */
function decodeValue(raw, where = '属性值') {
  checkChars(raw, where);
  if (raw.includes('<')) throw new Error(`${where}里有未转义的 <`);
  return raw.replace(/&([^;\s&<]*);?/g, (whole, body) => {
    if (!whole.endsWith(';')) throw new Error(`${where}里有不成引用的 &：${whole}`);
    if (Object.hasOwn(entities, body)) return entities[body];
    const num = /^#(?:x([0-9a-fA-F]+)|([0-9]+))$/.exec(body);
    const code = num ? parseInt(num[1] ?? num[2], num[1] ? 16 : 10) : NaN;
    if (!isXmlChar(code)) throw new Error(`${where}里有无效的实体：${whole}`);
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

/** 解析单份 JUnit XML，按文件合并测试数、失败数、跳过数和耗时；损坏报告（含正文、属性里的非法字符与引用）返回原因。 */
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
      if (raw.startsWith('<![CDATA[')) {
        if (!stack.length) throw new Error('根元素外有 CDATA');
        checkChars(raw.slice(9, -3), 'CDATA');
        continue;
      }
      if (!raw.startsWith('<')) {
        if (!stack.length && raw.trim()) throw new Error('根元素外有文本');
        decodeValue(raw, '正文');
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

/**
 * 一次追加本批次的 JSON 行，自动创建父目录。文件末尾没有换行（上次写到一半中断，或被手改过）时先补一个换行，
 * 不让新记录与旧的最后一行拼成一行而两条一起作废。
 */
export function appendEntries(file, entries) {
  if (!entries.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let lead = '';
  const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
  if (size > 0) {
    const fd = fs.openSync(file, 'r');
    try {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) lead = '\n';
    } finally { fs.closeSync(fd); }
  }
  fs.appendFileSync(file, lead + entries.map((e) => JSON.stringify(e) + '\n').join(''));
}

const isCount = (v) => Number.isFinite(v) && v >= 0;
const isText = (v) => typeof v === 'string' && v !== '';

/** 一行台账是否符合 ek-test-ledger/1；返回问题说明，合格返回 null。先查类型再解析，不对不可信的值做隐式转换。 */
export function entryProblem(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return '不是 JSON 对象';
  if (entry.schema !== SCHEMA) return 'schema 不认识';
  if (typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at))) return 'at 不是可解析的时间';
  if (!isText(entry.runId)) return 'runId 不是非空字符串';
  if (!['local', 'ci'].includes(entry.source)) return 'source 不是 local 或 ci';
  if (!(entry.commit === null || (typeof entry.commit === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(entry.commit)))) return 'commit 不是提交号或 null';
  if (!['full', 'affected'].includes(entry.mode)) return 'mode 不是 full 或 affected';
  if (!(entry.os === null || isText(entry.os))) return 'os 不是字符串或 null';
  if (!(entry.file === null || isText(entry.file))) return 'file 不是字符串或 null';
  if (!isText(entry.layer)) return 'layer 不是非空字符串';
  if (!['pass', 'fail', 'skip'].includes(entry.result)) return 'result 不是 pass、fail 或 skip';
  for (const k of ['tests', 'failures', 'skipped', 'durationMs']) if (!isCount(entry[k])) return `${k} 不是非负数`;
  if (!Array.isArray(entry.changed) || !entry.changed.every((f) => typeof f === 'string')) return 'changed 不是字符串数组';
  if (!(entry.note === null || typeof entry.note === 'string')) return 'note 不是字符串或 null';
  return null;
}

/** 读取台账，另列解析不了、schema 不认识或字段不合格的物理行号；文件不存在返回空。 */
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
    let entry;
    try { entry = JSON.parse(line); } catch { bad.push(i + 1); return; }
    if (entryProblem(entry)) bad.push(i + 1);
    else entries.push(entry);
  });
  return { entries, bad };
}

/** 统计窗口内的文件结果与层级失败率，长期未触发按全部历史的最近时间判断。 */
export function buildReport(entries, { now = Date.now(), sinceDays = null, staleDays = 30, testFiles = null } = {}) {
  const time = new Date(now).getTime();
  const recent = sinceDays === null ? entries : entries.filter((e) => Date.parse(e.at) >= time - sinceDays * DAY);
  // 只有整份台账一条都没有、又没给测试文件清单时才算“没有数据”；有历史而窗口里没有，按 windowEmpty 照常出报告
  if (!entries.length && testFiles === null) return { empty: true };
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
    const active = new Set(entries.filter((e) => Date.parse(e.at) >= time - staleDays * DAY).map((e) => e.file));
    report.untriggered = testFiles.filter((file) => !active.has(file));
  }
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
  section(`命令级记录 ${report.commandLevel.count} 条`, Object.entries(report.commandLevel.notes).map(([note, n]) => `${note}：${n} 条`));
  return lines.join('\n');
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

/**
 * 记录一次实际运行，返回条目供调用方显示计数。写共享台账（没给 out）时持 test-ledger 锁（各工作树共用），
 * 锁被占用时报错由调用方处理（闸门降为警告）。
 */
export function recordTests({ root, config, patterns = config.testReports, startedAt, exitCode, source = 'local',
  commit, mode = 'full', os: system = { linux: 'linux', win32: 'windows', darwin: 'macos' }[process.platform] ?? null,
  changed = [], runId, out }) {
  const defaultId = source === 'ci' && process.env.GITHUB_RUN_ID
    ? `ci-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? 1}-${system}` : `${source}-${randomUUID()}`;
  const entries = buildEntries({ root, reports: readReports(root, patterns, startedAt), testReportsConfigured: patterns.length > 0,
    testLayers: config.testLayers, exitCode, source, commit: commit === undefined ? headInfo(root).headSha : commit, mode,
    os: system, changed, at: new Date().toISOString(), runId: runId ?? defaultId });
  if (out) appendEntries(out, entries);
  else withLock(root, 'test-ledger', () => appendEntries(ledgerFile(root), entries), '测试台账的写入锁');
  return entries;
}

/** 取两个修订之间的改动文件；git 出错时显式报告原因。 */
export function changedBetween(root, base, commit = 'HEAD') {
  if (!base || base.startsWith('-') || !commit || commit.startsWith('-')) throw new Error('缺少或无效的比较修订');
  const diff = diffNames(root, [base, commit, '--']);
  if (!diff.ok) throw new Error(`读取改动文件失败：${diff.err.trim()}`);
  return diff.files;
}

/** 本地没有工程配置时使用默认值，允许在没装套件的仓库里独立记录和出报告。 */
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

/**
 * 巡检用的配置提示：没配 testReports 时提示补配（否则台账只记整条命令）；没配 testLayers 时提示补配；
 * 已跟踪文件命中多个层级时列出文件、命中的层和实际采用的层（第一个）。
 */
function layerHints(root, config) {
  const hints = [];
  if (!config.testReports.length) hints.push('提示：未配置 modules.gate.testReports，台账只记整条测试命令的通过或失败；在测试命令里打开 JUnit 报告并配置它后，可按测试文件统计');
  if (!config.testLayers.length) {
    hints.push('提示：未配置 modules.gate.testLayers，台账层级一律记“未分层”；在项目配置里按 unit、integration、e2e 等声明后可按层统计');
    return hints;
  }
  const tracked = git(root, ['ls-files', '-z']);
  if (!tracked.ok) return hints;
  const overlaps = [];
  for (const file of tracked.out.split('\0').filter(Boolean)) {
    const hit = config.testLayers.filter((layer) => matchesAny(file, layer.paths)).map((layer) => layer.name);
    if (hit.length > 1) overlaps.push(`  ${file}：命中 ${hit.join('、')}，采用 ${hit[0]}`);
  }
  if (overlaps.length) hints.push('提示：以下测试文件命中多个层级，按配置顺序取第一个：', ...overlaps);
  return hints;
}

function main([command, ...args]) {
  const root = repoRoot();
  if (command === 'record') {
    const v = options(args, ['exit-code', 'source', 'junit', 'mode', 'commit', 'os', 'run-id', 'changed-from', 'out']);
    if (!/^-?\d+$/.test(v['exit-code'] ?? '')) throw new Error('--exit-code 须为整数');
    if (v.source !== undefined && !['local', 'ci'].includes(v.source)) throw new Error('--source 须为 local 或 ci');
    if (v.mode !== undefined && !['full', 'affected'].includes(v.mode)) throw new Error('--mode 须为 full 或 affected');
    if (v.os !== undefined && !['linux', 'windows', 'macos'].includes(v.os)) throw new Error('--os 须为 linux、windows 或 macos');
    if (v.commit !== undefined && !/^[a-f0-9]{40}$/i.test(v.commit)) throw new Error('--commit 须为 40 位提交号');
    const commit = v.commit ?? headInfo(root).headSha;
    const changed = v['changed-from'] === undefined ? [] : changedBetween(root, v['changed-from'], commit);
    recordTests({ root, config: metricsConfig(root), patterns: v.junit, exitCode: Number(v['exit-code']), commit, changed,
      source: v.source, os: v.os, mode: v.mode, runId: v['run-id'], out: v.out });
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
  } else throw new Error('命令须为 record 或 report');
}

if (isMain(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error(`测试台账操作失败：${error.message}`);
    process.exitCode = 1;
  }
}
