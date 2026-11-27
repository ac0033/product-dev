// 测试台账测试（规格 spec-CD 第 2、3 节）：JUnit 解析、台账条目、台账读写合并、报告、record / pull / report / coverage 命令行。
// 业务含义：台账是“各测试文件每次运行的结果”的长期记录，用来发现从不失败的测试、不稳定的测试和长期没被触发的测试；
// 记录失败不能影响测试结论，所以解析、归属、去重这些环节都要有确定的行为。
// 用动态 import 加载被测模块：实现还没有时每条用例各自失败，而不是整个文件加载失败。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fakeGh } from './fixtures/fake-gh.mjs';
import { nodeTestXml, pytestXml, vitestXml } from './fixtures/junit-samples.mjs';
import { commitAll, git, tmpDir, tmpRepo, write } from './helpers.mjs';

const lib = () => import('../gate/test-ledger.mjs');
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'gate', 'test-ledger.mjs');
const NOW = '2026-11-27T00:00:00.000Z';
const DAY = 86400000;

/** 在仓库里运行 test-ledger 命令行。 */
function cli(root, args, env) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: env ?? process.env });
}

/** 已提交一份基线的仓库，带 tests/ 下几个真实存在的测试文件（JUnit 归属判断要看文件是否存在）。 */
function repoWithTests() {
  const root = tmpRepo();
  for (const f of ['tests/a.test.mjs', 'tests/b.test.mjs', 'tests/a&b.test.mjs', 'tests/test_a.py', 'tests/foo.test.ts', 'src/x.mjs']) write(root, f, '// x\n');
  commitAll(root, 'base');
  return root;
}

/** 一条合格的台账条目（文件级），overrides 覆盖字段。 */
function entry(overrides = {}) {
  return {
    schema: 'ek-test-ledger/1', at: NOW, runId: 'ci-1-1-linux', source: 'ci', commit: 'a'.repeat(40), mode: 'full', os: 'linux',
    file: 'tests/a.test.mjs', layer: 'unit', result: 'pass', tests: 3, failures: 0, skipped: 0, durationMs: 12, changed: [], note: null,
    ...overrides,
  };
}

const ago = (days) => new Date(Date.parse(NOW) - days * DAY).toISOString();
const slash = (p) => p.split(path.sep).join('/');
const names = (list) => list.map((x) => (typeof x === 'string' ? x : x.file));
/** 把任意嵌套值里的数字都收集出来（报告里各统计项的字段名规格没写死，按数值核对）。 */
const numbersIn = (v) => (typeof v === 'number' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(numbersIn) : []);

// ---------- C4 JUnit 解析 ----------

test('C4 JUnit：node --test 真实格式——顶层 testcase 带 file、testsuite 内用例归属 testsuite@file、注释跳过、失败只算一次、耗时按秒求和', async () => {
  const { parseJUnit } = await lib();
  const root = repoWithTests();
  const a = path.join(root, 'tests', 'a.test.mjs');
  const b = path.join(root, 'tests', 'b.test.mjs');
  const r = parseJUnit(nodeTestXml({ a, b }), { root });
  assert.equal(r.ok, true, JSON.stringify(r));
  const by = Object.fromEntries(r.files.map((f) => [f.file, f]));
  assert.deepEqual(Object.keys(by).sort(), ['tests/a.test.mjs', 'tests/b.test.mjs'], '绝对路径转成相对仓库根、正斜杠');
  assert.deepEqual([by['tests/a.test.mjs'].tests, by['tests/a.test.mjs'].failures, by['tests/a.test.mjs'].skipped], [2, 0, 0], '同一文件的多个用例合并计数');
  assert.equal(by['tests/a.test.mjs'].durationMs, 750, '0.25 + 0.5 秒 = 750 毫秒');
  assert.deepEqual([by['tests/b.test.mjs'].tests, by['tests/b.test.mjs'].failures], [2, 1], '同时有 failure 属性与 failure 子元素的用例只算一次失败');
});

test('C4 JUnit：testsuite 没有 file 且名字不是文件、用例也没有 file → （未知文件）', async () => {
  const { parseJUnit } = await lib();
  const root = repoWithTests();
  const xml = '<?xml version="1.0"?>\n<testsuites><testsuite name="grp" tests="1"><testcase name="x" classname="test" time="0.1"/></testsuite></testsuites>';
  const r = parseJUnit(xml, { root });
  assert.equal(r.ok, true);
  assert.deepEqual(r.files.map((f) => f.file), ['（未知文件）']);
});

test('C4 JUnit：归属顺序——testcase@file 优先于 testsuite@file', async () => {
  const { parseJUnit } = await lib();
  const root = repoWithTests();
  const xml = `<testsuites><testsuite name="s" file="${path.join(root, 'tests', 'b.test.mjs')}"><testcase name="t" file="${path.join(root, 'tests', 'a.test.mjs')}"/></testsuite></testsuites>`;
  assert.deepEqual(parseJUnit(xml, { root }).files.map((f) => f.file), ['tests/a.test.mjs']);
});

test('C4 JUnit：vitest 式——testsuite name 是仓库里存在的相对文件路径', async () => {
  const { parseJUnit } = await lib();
  const root = repoWithTests();
  const r = parseJUnit(vitestXml('tests/foo.test.ts'), { root });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.files.length, 1);
  assert.deepEqual([r.files[0].file, r.files[0].tests, r.files[0].failures], ['tests/foo.test.ts', 2, 1]);
  assert.equal(r.files[0].durationMs, 400, '0.1 + 0.3 秒');
});

test('C4 JUnit：pytest 式——classname 点号换斜杠加 .py 后存在则归属该文件；不存在则 （未知文件）；跳过计数', async () => {
  const { parseJUnit } = await lib();
  const root = repoWithTests();
  const r = parseJUnit(pytestXml('tests.test_a'), { root });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.files.map((f) => f.file), ['tests/test_a.py']);
  assert.equal(r.files[0].skipped, 1);
  assert.equal(r.files[0].failures, 0);
  assert.deepEqual(parseJUnit(pytestXml('tests.test_missing'), { root }).files.map((f) => f.file), ['（未知文件）']);
});

test('C4 JUnit：error 子元素算失败；skipped 子元素算跳过', async () => {
  const { parseJUnit } = await lib();
  const root = repoWithTests();
  const f = path.join(root, 'tests', 'a.test.mjs');
  const xml = `<testsuites><testsuite name="s" file="${f}"><testcase name="e"><error message="boom"/></testcase><testcase name="s1"><skipped/></testcase><testcase name="s2"><skipped message="x"/></testcase></testsuite></testsuites>`;
  const [one] = parseJUnit(xml, { root }).files;
  assert.equal(one.failures, 1);
  assert.equal(one.skipped, 2);
});

test('C4 JUnit：实体解码（&amp; 等）；注释与 CDATA 里的 testcase 文字不当真', async () => {
  const { parseJUnit } = await lib();
  const root = repoWithTests();
  const f = path.join(root, 'tests', 'a&b.test.mjs').replace(/&/g, '&amp;');
  const ghost = path.join(root, 'tests', 'b.test.mjs');
  const xml = `<testsuites><!-- <testcase name="ghost" file="${ghost}"/> --><testsuite name="s"><testcase name="q &quot;x&quot; &lt;y&gt;" file="${f}"><failure><![CDATA[</testcase><testcase name="ghost2" file="${ghost}"/>]]></failure></testcase></testsuite></testsuites>`;
  const r = parseJUnit(xml, { root });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.files.map((x) => x.file), ['tests/a&b.test.mjs'], '实体已解码，注释和 CDATA 里的文字不产生用例');
  assert.deepEqual([r.files[0].tests, r.files[0].failures], [1, 1]);
});

test('C4 JUnit：root 之外的绝对路径保留原样（含 Windows 盘符反斜杠写法）', async () => {
  const { parseJUnit } = await lib();
  const root = repoWithTests();
  const outside = 'Q:\\somewhere\\else\\t\\x.test.mjs';
  const xml = `<testsuites><testcase name="t" classname="test" file="${outside}"/></testsuites>`;
  assert.deepEqual(parseJUnit(xml, { root }).files.map((f) => f.file), [outside]);
});

test('C4 JUnit：Windows 绝对路径（反斜杠、盘符大小写不同）转成相对路径', { skip: process.platform !== 'win32' && 'Windows 专有写法' }, async () => {
  const { parseJUnit } = await lib();
  const root = repoWithTests();
  const swap = (p) => (p[0] === p[0].toLowerCase() ? p[0].toUpperCase() : p[0].toLowerCase()) + p.slice(1);
  const win = swap(path.join(root, 'tests', 'a.test.mjs')).replace(/\//g, '\\');
  const xml = `<testsuites><testcase name="t" classname="test" file="${win}"/></testsuites>`;
  assert.deepEqual(parseJUnit(xml, { root }).files.map((f) => f.file), ['tests/a.test.mjs']);
});

test('C4 JUnit：损坏的 XML、不是 XML、根元素不对、标签不配对 → ok: false 带原因', async () => {
  const { parseJUnit } = await lib();
  const root = repoWithTests();
  for (const bad of ['not xml at all', '', '<html><body/></html>', '<testsuites><testsuite name="x"><testcase name="t"></testsuite></testsuites>', '<testsuites><testsuite name="x">']) {
    const r = parseJUnit(bad, { root });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(typeof r.error === 'string' && r.error.length > 0, 'error 要有内容');
  }
});

// ---------- C2/C5 layerOf、buildEntries ----------

test('C2 分层：按 testLayers 顺序取第一个命中的层；都不命中或没配为 未分层', async () => {
  const { layerOf } = await lib();
  const layers = [{ name: 'unit', paths: ['tests/unit/**'] }, { name: 'all', paths: ['tests/**'] }];
  assert.equal(layerOf('tests/unit/a.test.mjs', layers), 'unit');
  assert.equal(layerOf('tests/other/b.test.mjs', layers), 'all', '第一个没命中，取下一个命中的');
  assert.equal(layerOf('src/x.mjs', layers), '未分层');
  assert.equal(layerOf('tests/a.test.mjs', []), '未分层');
  assert.equal(layerOf('tests/a.test.mjs', undefined), '未分层');
});

const BASE_ARGS = { exitCode: 0, source: 'ci', commit: 'c'.repeat(40), mode: 'full', os: 'linux', changed: ['src/x.mjs'], testLayers: [{ name: 'unit', paths: ['tests/**'] }], testReportsConfigured: true, at: NOW, runId: 'ci-9-1-linux' };
const junit = (cases) => `<testsuites>${cases}</testsuites>`;
const tc = (file, inner = '') => `<testcase name="t" classname="test" file="${file}" time="0.1">${inner}</testcase>`;

test('C5 条目：没配 testReports → 一条命令级条目，result 按退出码，note 为 未配置 testReports，字段透传', async () => {
  const { buildEntries } = await lib();
  const ok = buildEntries({ ...BASE_ARGS, testReportsConfigured: false, reports: [], exitCode: 0 });
  assert.equal(ok.length, 1);
  assert.equal(ok[0].schema, 'ek-test-ledger/1');
  assert.deepEqual([ok[0].file, ok[0].result, ok[0].note, ok[0].layer], [null, 'pass', '未配置 testReports', '未分层']);
  assert.deepEqual([ok[0].at, ok[0].runId, ok[0].source, ok[0].commit, ok[0].mode, ok[0].os, ok[0].changed], [NOW, 'ci-9-1-linux', 'ci', 'c'.repeat(40), 'full', 'linux', ['src/x.mjs']]);
  const bad = buildEntries({ ...BASE_ARGS, testReportsConfigured: false, reports: [], exitCode: 2 });
  assert.deepEqual([bad[0].file, bad[0].result], [null, 'fail']);
});

test('C5 条目：配了 testReports 但没有报告 → 命令级，note 为 未找到 JUnit 报告', async () => {
  const { buildEntries } = await lib();
  const [e, ...rest] = buildEntries({ ...BASE_ARGS, reports: [], exitCode: 1 });
  assert.equal(rest.length, 0);
  assert.deepEqual([e.file, e.result, e.note], [null, 'fail', '未找到 JUnit 报告']);
});

test('C5 条目：某份报告解析失败 → 该份记一条命令级 JUnit 解析失败，其余照常', async () => {
  const { buildEntries } = await lib();
  const reports = [{ path: 'r1.xml', text: '<<<坏的' }, { path: 'r2.xml', text: junit(tc('tests/a.test.mjs')) }];
  const out = buildEntries({ ...BASE_ARGS, reports });
  const cmd = out.filter((e) => e.file === null);
  assert.equal(cmd.length, 1);
  assert.match(cmd[0].note, /^JUnit 解析失败：/);
  const files = out.filter((e) => e.file !== null);
  assert.deepEqual(files.map((e) => [e.file, e.result, e.layer]), [['tests/a.test.mjs', 'pass', 'unit']]);
});

test('C5 条目：全部解析成功 → 每个文件一条；有失败为 fail，全部跳过为 skip，否则 pass；统计与分层带上', async () => {
  const { buildEntries } = await lib();
  const xml = junit([
    tc('tests/a.test.mjs'), tc('tests/a.test.mjs'),
    tc('tests/b.test.mjs', '<failure message="x"/>'),
    tc('tests/c.test.mjs', '<skipped/>'),
  ].join(''));
  const out = buildEntries({ ...BASE_ARGS, exitCode: 1, reports: [{ path: 'r.xml', text: xml }] });
  const by = Object.fromEntries(out.map((e) => [e.file, e]));
  assert.equal(out.length, 3, '有失败用例，退出码非 0 与报告一致，不再追加命令级条目');
  assert.deepEqual([by['tests/a.test.mjs'].result, by['tests/a.test.mjs'].tests, by['tests/a.test.mjs'].failures], ['pass', 2, 0]);
  assert.deepEqual([by['tests/b.test.mjs'].result, by['tests/b.test.mjs'].failures], ['fail', 1]);
  assert.deepEqual([by['tests/c.test.mjs'].result, by['tests/c.test.mjs'].skipped], ['skip', 1]);
  assert.equal(by['tests/a.test.mjs'].layer, 'unit');
  assert.equal(by['tests/a.test.mjs'].note, null);
});

test('C5 条目：命令退出码非 0 而所有文件级条目都是 pass → 另加一条命令级 fail', async () => {
  const { buildEntries } = await lib();
  const reports = [{ path: 'r.xml', text: junit(tc('tests/a.test.mjs')) }];
  const out = buildEntries({ ...BASE_ARGS, exitCode: 1, reports });
  assert.equal(out.length, 2);
  const cmd = out.find((e) => e.file === null);
  assert.deepEqual([cmd.result, cmd.note], ['fail', '测试命令失败，但报告里没有失败用例']);
  assert.equal(buildEntries({ ...BASE_ARGS, exitCode: 0, reports }).length, 1, '退出码 0 不追加');
});

// ---------- 台账文件 ----------

test('C3 台账路径：ledgerFile 在 git 公共目录的 engineering-gate/test-ledger.jsonl', async () => {
  const { ledgerFile } = await lib();
  const root = tmpRepo();
  commitAll(root, 'base');
  const common = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  assert.equal(path.resolve(ledgerFile(root)), path.resolve(common, 'engineering-gate', 'test-ledger.jsonl'));
});

test('C3 台账读写：appendEntries 建目录并逐行追加；readLedger 返回条目与坏行（解析失败、schema 不对的物理行号）；文件不存在返回空', async () => {
  const { appendEntries, readLedger } = await lib();
  const dir = tmpDir('ekit-ledger-');
  const file = path.join(dir, 'deep', 'er', 'ledger.jsonl');
  assert.deepEqual(readLedger(file), { entries: [], bad: [] });
  appendEntries(file, [entry({ runId: 'r1' }), entry({ runId: 'r2' })]);
  appendEntries(file, [entry({ runId: 'r3' })]);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 3, '每条一行、追加不覆盖');
  fs.appendFileSync(file, 'this is not json\n');
  fs.appendFileSync(file, `${JSON.stringify({ schema: 'other/9', file: 'x' })}\n`);
  appendEntries(file, [entry({ runId: 'r4' })]);
  const got = readLedger(file);
  assert.deepEqual(got.entries.map((e) => e.runId), ['r1', 'r2', 'r3', 'r4']);
  assert.deepEqual(got.bad, [4, 5], '坏行用物理行号（从 1 数）');
});

test('C5 pull 去重：mergeEntries 按 (schema, runId, source, file, note) 去重，只返回要追加的新条目（命令级 file 为 null 同样参与）', async () => {
  const { mergeEntries } = await lib();
  const existing = [entry({ runId: 'r1' }), entry({ runId: 'r1', file: null, layer: '未分层', note: 'x' })];
  const incoming = [
    entry({ runId: 'r1' }),
    entry({ runId: 'r1', file: null, layer: '未分层', note: 'x' }),
    entry({ runId: 'r1', file: 'tests/b.test.mjs' }),
    entry({ runId: 'r1', source: 'local' }),
    entry({ runId: 'r2' }),
  ];
  const fresh = mergeEntries(existing, incoming);
  assert.deepEqual(fresh.map((e) => `${e.runId}|${e.source}|${e.file}`), ['r1|ci|tests/b.test.mjs', 'r1|local|tests/a.test.mjs', 'r2|ci|tests/a.test.mjs']);
});

// ---------- C5 报告 ----------

test('C5 报告：始终通过 / 始终失败 / 不稳定分类，只看文件级条目（命令级与 （未知文件） 不参与）', async () => {
  const { buildReport } = await lib();
  const es = [
    ...[1, 2, 3].map((i) => entry({ runId: `p${i}`, file: 'tests/a.test.mjs', at: ago(i) })),
    ...[1, 2].map((i) => entry({ runId: `f${i}`, file: 'tests/b.test.mjs', result: 'fail', failures: 1, at: ago(i) })),
    ...[1, 2, 3].map((i) => entry({ runId: `m${i}`, file: 'tests/c.test.mjs', at: ago(i) })),
    entry({ runId: 'm4', file: 'tests/c.test.mjs', result: 'fail', failures: 1, at: ago(4) }),
    entry({ runId: 'u1', file: '（未知文件）' }),
    entry({ runId: 'n1', file: null, layer: '未分层', note: '未配置 testReports' }),
    entry({ runId: 'n2', file: null, layer: '未分层', note: '未配置 testReports' }),
    entry({ runId: 'n3', file: null, layer: '未分层', note: '未找到 JUnit 报告', result: 'fail' }),
  ];
  const r = buildReport(es, { now: NOW });
  assert.notEqual(r.empty, true);
  assert.deepEqual(names(r.alwaysPass).sort(), ['tests/a.test.mjs']);
  assert.deepEqual(names(r.alwaysFail).sort(), ['tests/b.test.mjs']);
  assert.deepEqual(names(r.flaky), ['tests/c.test.mjs']);
  const flaky = r.flaky[0];
  assert.ok(numbersIn(flaky).includes(3) && numbersIn(flaky).includes(1), `不稳定项要附 pass 3 次、fail 1 次：${JSON.stringify(flaky)}`);
  const cmd = JSON.stringify(r.commandLevel);
  assert.ok(cmd.includes('未配置 testReports') && cmd.includes('未找到 JUnit 报告'), cmd);
  assert.ok(numbersIn(r.commandLevel).includes(3) && numbersIn(r.commandLevel).includes(2), `命令级共 3 条，其中未配置 2 条：${cmd}`);
});

test('C5 报告：各层的文件数、运行次数、失败次数、失败率', async () => {
  const { buildReport } = await lib();
  const es = [
    entry({ runId: 'a1', file: 'tests/u1.test.mjs', layer: 'unit' }),
    entry({ runId: 'a2', file: 'tests/u1.test.mjs', layer: 'unit', result: 'fail', failures: 1 }),
    entry({ runId: 'a3', file: 'tests/u2.test.mjs', layer: 'unit' }),
    entry({ runId: 'a4', file: 'tests/u2.test.mjs', layer: 'unit' }),
    entry({ runId: 'b1', file: 'tests/e.test.mjs', layer: 'e2e', result: 'fail', failures: 1 }),
  ];
  const r = buildReport(es, { now: NOW });
  const layer = (name) => (Array.isArray(r.layers) ? r.layers.find((l) => l.name === name || l.layer === name) : r.layers[name]);
  const unit = layer('unit');
  const e2e = layer('e2e');
  assert.ok(unit && e2e, JSON.stringify(r.layers));
  const got = numbersIn(unit);
  for (const n of [2, 4, 1]) assert.ok(got.includes(n), `unit 层应含 ${n}（2 个文件、4 次运行、1 次失败）：${JSON.stringify(unit)}`);
  assert.ok(got.includes(0.25) || got.includes(25), `unit 层失败率 25%：${JSON.stringify(unit)}`);
  assert.ok(numbersIn(e2e).includes(1), JSON.stringify(e2e));
});

test('C5 报告：长期没被触发的测试——testFiles 里最近出现时间早于 now-staleDays 天或从未出现；不传 testFiles 不算这一项', async () => {
  const { buildReport } = await lib();
  const es = [
    entry({ runId: 'x1', file: 'tests/fresh.test.mjs', at: ago(1) }),
    entry({ runId: 'x2', file: 'tests/stale.test.mjs', at: ago(40) }),
    entry({ runId: 'x3', file: 'tests/stale.test.mjs', at: ago(45) }),
  ];
  const testFiles = ['tests/fresh.test.mjs', 'tests/stale.test.mjs', 'tests/never.test.mjs'];
  const r = buildReport(es, { now: NOW, testFiles });
  assert.deepEqual(names(r.untriggered).sort(), ['tests/never.test.mjs', 'tests/stale.test.mjs']);
  assert.deepEqual(names(buildReport(es, { now: NOW, testFiles, staleDays: 50 }).untriggered).sort(), ['tests/never.test.mjs'], 'staleDays 可调，缺省 30');
  const none = buildReport(es, { now: NOW });
  assert.ok(!none.untriggered || none.untriggered.length === 0, 'testFiles 为 null 时不算 untriggered');
});

test('C5 报告：sinceDays 只算窗口内的条目', async () => {
  const { buildReport } = await lib();
  const es = [
    entry({ runId: 'n1', file: 'tests/new.test.mjs', at: ago(2) }),
    entry({ runId: 'o1', file: 'tests/old.test.mjs', result: 'fail', failures: 1, at: ago(40) }),
  ];
  const all = buildReport(es, { now: NOW });
  assert.deepEqual(names(all.alwaysFail), ['tests/old.test.mjs']);
  const recent = buildReport(es, { now: NOW, sinceDays: 7 });
  assert.deepEqual(names(recent.alwaysFail), []);
  assert.deepEqual(names(recent.alwaysPass), ['tests/new.test.mjs']);
  const none = buildReport(es, { now: NOW, sinceDays: 0.5 });
  assert.notEqual(none.empty, true, '台账有历史：窗口里一条都没有不再算空台账');
  assert.equal(none.windowEmpty, true, '而是 windowEmpty');
});

test('C5 报告：空台账返回 empty；formatReport 空台账输出 台账里还没有数据，非空为多行中文且含文件名', async () => {
  const { buildReport, formatReport } = await lib();
  const empty = buildReport([], { now: NOW });
  assert.equal(empty.empty, true);
  assert.match(formatReport(empty), /台账里还没有数据/);
  const text = formatReport(buildReport([entry({ runId: 'p1', file: 'tests/zzz.test.mjs' }), entry({ runId: 'p2', file: 'tests/zzz.test.mjs' })], { now: NOW }));
  assert.ok(text.split('\n').length > 1, '先一行概要，再分节');
  assert.ok(text.includes('tests/zzz.test.mjs'));
});

// ---------- C3/C4 record 命令行 ----------

/** 把 JUnit 文本写到仓库外的临时目录，返回目录。 */
function junitDir(files) {
  const dir = tmpDir('ekit-junit-');
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}
const readJsonl = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('C3 record：--junit 绝对 glob（CI 写法）、--source/--os/--run-id/--mode/--commit 透传，写 --out，退出码 0（即使测试失败）', () => {
  const root = repoWithTests();
  const dir = junitDir({ 'junit-1.xml': nodeTestXml({ a: path.join(root, 'tests', 'a.test.mjs'), b: path.join(root, 'tests', 'b.test.mjs') }) });
  const out = path.join(dir, 'ledger.jsonl');
  const sha = 'd'.repeat(40);
  const r = cli(root, ['record', '--exit-code', '1', '--source', 'ci', '--junit', `${slash(dir)}/junit-*.xml`, '--mode', 'full', '--commit', sha, '--os', 'linux', '--run-id', 'ci-5-2-linux', '--out', out]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const es = readJsonl(out);
  assert.deepEqual(es.map((e) => e.file).sort(), ['tests/a.test.mjs', 'tests/b.test.mjs']);
  for (const e of es) assert.deepEqual([e.schema, e.source, e.os, e.runId, e.mode, e.commit, e.layer], ['ek-test-ledger/1', 'ci', 'linux', 'ci-5-2-linux', 'full', sha, '未分层'], '没有配置文件时层级全为未分层、不报错');
  assert.equal(es.find((e) => e.file === 'tests/b.test.mjs').result, 'fail');
  assert.match(es[0].at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/, '时间是 UTC ISO 8601');
});

test('C3 record：没给 --junit 且无配置 → 一条命令级条目 未配置 testReports，按退出码；--commit 缺省取 HEAD', () => {
  const root = repoWithTests();
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const out = path.join(tmpDir('ekit-out-'), 'l.jsonl');
  assert.equal(cli(root, ['record', '--exit-code', '0', '--source', 'local', '--out', out]).status, 0);
  assert.equal(cli(root, ['record', '--exit-code', '4', '--source', 'local', '--out', out]).status, 0);
  const [ok, bad] = readJsonl(out);
  assert.deepEqual([ok.file, ok.result, ok.note, ok.commit, ok.source], [null, 'pass', '未配置 testReports', head, 'local']);
  assert.deepEqual([bad.result], ['fail']);
  assert.equal(readJsonl(out).length, 2, '追加不覆盖');
});

test('C3 record：没给 --junit 时取配置的 testReports，层级按 testLayers', () => {
  const root = repoWithTests();
  write(root, 'engineering.config.json', JSON.stringify({ profile: 2, modules: { gate: { testReports: ['reports/*.xml'], testLayers: [{ name: 'unit', paths: ['tests/**'] }] } }, layout: { sourceGlobs: ['src/**/*.mjs'], testGlobs: ['tests/**/*.test.mjs'] } }));
  write(root, 'reports/j.xml', vitestXml('tests/foo.test.ts'));
  commitAll(root, 'cfg');
  const out = path.join(tmpDir('ekit-out-'), 'l.jsonl');
  const r = cli(root, ['record', '--exit-code', '1', '--source', 'local', '--out', out]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const [e] = readJsonl(out);
  assert.deepEqual([e.file, e.layer, e.result], ['tests/foo.test.ts', 'unit', 'fail']);
});

test('C3 record：--changed-from 给了时 changed 为该修订到 commit 的改动文件（--no-renames）', () => {
  const root = repoWithTests();
  const first = git(root, ['rev-parse', 'HEAD']).trim();
  write(root, 'src/x.mjs', '// changed\n');
  write(root, 'docs/n.md', 'n\n');
  commitAll(root, 'second');
  const dir = junitDir({ 'j.xml': vitestXml('tests/foo.test.ts') });
  const out = path.join(dir, 'l.jsonl');
  const r = cli(root, ['record', '--exit-code', '0', '--source', 'local', '--junit', `${slash(dir)}/j.xml`, '--changed-from', first, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readJsonl(out)[0].changed.sort(), ['docs/n.md', 'src/x.mjs']);
});

test('C3 record：--out 缺省写 ledgerFile（git 公共目录下）；参数错误退出码 1（缺 --exit-code、没有子命令、退出码不是数字）', async () => {
  const { ledgerFile } = await lib();
  const root = repoWithTests();
  assert.equal(cli(root, ['record', '--source', 'local']).status, 1, '缺 --exit-code');
  assert.equal(cli(root, []).status, 1, '没有子命令');
  assert.equal(cli(root, ['record', '--exit-code', 'abc', '--source', 'local']).status, 1, '退出码不是数字');
  const r = cli(root, ['record', '--exit-code', '0', '--source', 'local']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readJsonl(ledgerFile(root)).length, 1);
});

// ---------- C5 report 命令行 ----------

test('C5 report：读 --ledger，打印概要与分类；有坏行时先打印 跳过 N 行坏行 和行号；空台账 台账里还没有数据', () => {
  const root = repoWithTests();
  const dir = tmpDir('ekit-rep-');
  const file = path.join(dir, 'l.jsonl');
  const now = Date.now();
  const rec = (n, result) => JSON.stringify(entry({ runId: `r${n}`, file: 'tests/a.test.mjs', result, at: new Date(now - n * 1000).toISOString() }));
  fs.writeFileSync(file, [rec(1, 'pass'), 'garbage', rec(2, 'pass')].join('\n') + '\n');
  const r = cli(root, ['report', '--ledger', file]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /跳过 1 行坏行/);
  assert.ok(r.stdout.includes('tests/a.test.mjs'));
  const empty = cli(root, ['report', '--ledger', path.join(dir, 'nope.jsonl')]);
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /台账里还没有数据/);
});

test('C5 report：--since 过滤旧条目；无配置时不算 untriggered，有配置 testGlobs 时列出从未被触发的已跟踪测试', () => {
  const root = repoWithTests();
  const dir = tmpDir('ekit-rep-');
  const file = path.join(dir, 'l.jsonl');
  fs.writeFileSync(file, `${JSON.stringify(entry({ runId: 'r1', file: 'tests/a.test.mjs', at: new Date().toISOString() }))}\n${JSON.stringify(entry({ runId: 'r0', file: 'tests/old.test.mjs', at: new Date(Date.now() - 100 * DAY).toISOString() }))}\n`);
  const since = cli(root, ['report', '--ledger', file, '--since', '7']);
  assert.equal(since.status, 0, since.stderr);
  assert.ok(since.stdout.includes('tests/a.test.mjs') && !since.stdout.includes('tests/old.test.mjs'));
  assert.ok(!cli(root, ['report', '--ledger', file]).stdout.includes('tests/b.test.mjs'), '无配置：不算 untriggered');
  write(root, 'engineering.config.json', JSON.stringify({ profile: 2, layout: { sourceGlobs: ['src/**/*.mjs'], testGlobs: ['tests/**/*.test.mjs'] } }));
  commitAll(root, 'cfg');
  const withCfg = cli(root, ['report', '--ledger', file, '--since', '7']);
  assert.equal(withCfg.status, 0, withCfg.stderr);
  assert.ok(withCfg.stdout.includes('tests/b.test.mjs'), '已跟踪的测试文件从未出现在台账里');
});

// ---------- C5 pull 命令行（假 gh） ----------

const lines = (...es) => `${es.map((e) => JSON.stringify(e)).join('\n')}\n`;

test('C5 pull：gh pr view → gh run list → 对每个已完成的运行 gh run download；合并去重后追加；产物不存在的运行跳过并列出；再拉一次不重复', async () => {
  const { readLedger, ledgerFile } = await lib();
  const root = repoWithTests();
  const sha = 'e'.repeat(40);
  const shared = entry({ runId: 'ci-101-1-linux', file: 'tests/a.test.mjs' });
  const gh = fakeGh({
    prHead: sha,
    runs: [
      { databaseId: 101, attempt: 1, status: 'completed', conclusion: 'success', name: 'CI' },
      { databaseId: 102, attempt: 1, status: 'completed', conclusion: 'failure', name: 'CI' },
      { databaseId: 103, attempt: 1, status: 'in_progress', conclusion: '', name: 'CI' },
      { databaseId: 104, attempt: 1, status: 'completed', conclusion: 'success', name: 'Other' },
    ],
    artifacts: {
      101: { 'test-ledger-linux/l.jsonl': lines(shared, entry({ runId: 'ci-101-1-linux', file: 'tests/b.test.mjs' })) },
      102: { 'test-ledger-linux/l.jsonl': lines(shared, entry({ runId: 'ci-102-1-linux', file: 'tests/a.test.mjs', result: 'fail' })), 'test-ledger-windows/l.jsonl': lines(entry({ runId: 'ci-102-1-windows', os: 'windows' })) },
    },
  });
  const r = cli(root, ['pull', '--pr', '7'], gh.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const got = readLedger(ledgerFile(root)).entries;
  assert.deepEqual(got.map((e) => `${e.runId}|${e.file}`).sort(), [
    'ci-101-1-linux|tests/a.test.mjs', 'ci-101-1-linux|tests/b.test.mjs', 'ci-102-1-linux|tests/a.test.mjs', 'ci-102-1-windows|tests/a.test.mjs',
  ], '重复的 (schema, runId, source, file, note) 只留一条');
  for (const id of ['101', '102', '104']) assert.ok(r.stdout.includes(id), `输出要提到运行 ${id}（拉回的或跳过的）`);
  assert.match(r.stdout, /新增/);
  const calls = gh.calls();
  const view = calls.find((c) => c[0] === 'pr' && c[1] === 'view');
  assert.ok(view && view.includes('7') && view.includes('--json') && view.includes('headRefOid'), JSON.stringify(view));
  const list = calls.find((c) => c[0] === 'run' && c[1] === 'list');
  assert.ok(list && list.includes('--commit') && list.includes(sha) && list.includes('--json') && list.includes('databaseId,attempt,status,conclusion,name'), JSON.stringify(list));
  const downloads = calls.filter((c) => c[1] === 'download');
  assert.deepEqual(downloads.map((c) => c[2]).sort(), ['101', '102', '104'], '只对已完成的运行下载（103 未完成）');
  assert.ok(downloads.every((c) => c.includes('--pattern') && c[c.indexOf('--pattern') + 1].startsWith('test-ledger') && c.includes('--dir')));
  const again = cli(root, ['pull', '--pr', '7'], gh.env);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readLedger(ledgerFile(root)).entries.length, 4, '再拉一次不新增');
});

test('C5 pull：gh 失败 → 报错退出 1，不写台账', async () => {
  const { ledgerFile } = await lib();
  const root = repoWithTests();
  for (const failOn of ['pr view', 'run list']) {
    const gh = fakeGh({ prHead: 'f'.repeat(40), runs: [{ databaseId: 1, attempt: 1, status: 'completed', conclusion: 'success', name: 'CI' }], artifacts: { 1: { 'test-ledger-linux/l.jsonl': lines(entry()) } }, failOn });
    const r = cli(root, ['pull', '--pr', '7'], gh.env);
    assert.equal(r.status, 1, failOn + r.stdout);
    assert.equal(fs.existsSync(ledgerFile(root)), false, '失败时不写台账');
  }
});

// ---------- C6 覆盖率 ----------

/** 一份 lcov：a.mjs 10 行命中 8、4 个分支取到 3；other.mjs 全未覆盖。路径用绝对路径（lcov 常见写法）。 */
function lcov(root) {
  const a = path.join(root, 'src', 'a.mjs');
  const o = path.join(root, 'src', 'other.mjs');
  const da = (n, hit) => Array.from({ length: n }, (_, i) => `DA:${i + 1},${i < hit ? 1 : 0}`).join('\n');
  return `TN:\nSF:${a}\n${da(10, 8)}\nBRDA:3,0,0,1\nBRDA:3,0,1,1\nBRDA:5,0,0,1\nBRDA:5,0,1,-\nend_of_record\nSF:${o}\n${da(10, 0)}\nBRDA:1,0,0,0\nBRDA:1,0,1,-\nend_of_record\n`;
}

test('C6 lcov：parseLcov 把绝对路径转成相对 root；coverageSummary 只统计改动过的文件', async () => {
  const { parseLcov, coverageSummary } = await lib();
  const root = repoWithTests();
  const files = parseLcov(lcov(root), { root });
  const text = JSON.stringify(files);
  assert.ok(text.includes('src/a.mjs') && text.includes('src/other.mjs'));
  assert.ok(!text.includes(slash(root)) && !text.includes(JSON.stringify(root).slice(1, -1)), '绝对路径已转成相对路径');
  const summary = coverageSummary(files, ['src/a.mjs']);
  const s = typeof summary === 'string' ? summary : JSON.stringify(summary);
  assert.ok(s.includes('src/a.mjs') && !s.includes('other.mjs'), '未改动的文件不统计');
  assert.ok(/80(\.0+)?/.test(s) && /75(\.0+)?/.test(s), `行覆盖率 80%、分支覆盖率 75%：${s}`);
});

test('C6 coverage 命令：只统计相对 --base 改动的文件，Markdown 表追加写进 --summary 文件并打印到标准输出', () => {
  const root = repoWithTests();
  write(root, 'src/a.mjs', '// a\n');
  write(root, 'src/other.mjs', '// o\n');
  commitAll(root, 'add sources');
  const base = git(root, ['rev-parse', 'HEAD']).trim();
  write(root, 'src/a.mjs', '// a changed\n');
  commitAll(root, 'change a');
  const dir = tmpDir('ekit-cov-');
  const lcovFile = path.join(dir, 'lcov.info');
  fs.writeFileSync(lcovFile, lcov(root));
  const summary = path.join(dir, 'summary.md');
  fs.writeFileSync(summary, '已有内容\n');
  const r = cli(root, ['coverage', '--lcov', lcovFile, '--base', base, '--summary', summary]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const written = fs.readFileSync(summary, 'utf8');
  assert.ok(written.startsWith('已有内容\n'), '追加而不是覆盖');
  for (const text of [written, r.stdout]) {
    assert.ok(text.includes('src/a.mjs'), text);
    assert.ok(!text.includes('other.mjs'), '未改动的文件不出现');
    assert.match(text, /80(\.0+)?%/);
    assert.match(text, /75(\.0+)?%/);
    assert.match(text, /\|/, 'Markdown 表');
  }
});

test('C6 coverage 命令：改动的文件都不在 lcov 里 → 写 本次改动的文件没有覆盖率数据', () => {
  const root = repoWithTests();
  const base = git(root, ['rev-parse', 'HEAD']).trim();
  write(root, 'docs/only.md', 'x\n');
  commitAll(root, 'docs only');
  const dir = tmpDir('ekit-cov-');
  const lcovFile = path.join(dir, 'lcov.info');
  fs.writeFileSync(lcovFile, lcov(root));
  const summary = path.join(dir, 'summary.md');
  const r = cli(root, ['coverage', '--lcov', lcovFile, '--base', base, '--summary', summary]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(summary, 'utf8'), /本次改动的文件没有覆盖率数据/);
  assert.match(r.stdout, /本次改动的文件没有覆盖率数据/);
});

// ---------- 首轮复审回归（H1、H2、M4–M9） ----------

const RUN2 = { databaseId: 201, attempt: 2, status: 'completed', conclusion: 'success', name: 'CI' };
const covEntry = (over = {}) => ({
  schema: 'ek-coverage/1', at: NOW, runId: 'ci-201-2-coverage', source: 'ci', commit: 'a'.repeat(40), os: 'linux', file: 'src/a.mjs',
  lines: { hit: 8, total: 10 }, branches: { hit: 3, total: 4 }, ...over,
});

test('H1 pull：只接受 schema 合法、source 为 ci、runId 以 ci-<运行号>-<attempt>- 开头、字段类型正确的条目；其余拒绝不写台账，输出 拒绝 N 条', async () => {
  const { readLedger, ledgerFile } = await lib();
  const root = repoWithTests();
  const good = [
    entry({ runId: 'ci-201-2-linux', file: 'tests/a.test.mjs' }),
    entry({ runId: 'ci-201-2-linux', file: null, layer: '未分层', note: '未配置 testReports' }),
  ];
  const bad = [
    entry({ runId: 'ci-201-2-windows', os: 'windows', file: 'tests/b.test.mjs' }), // linux 产物里自报 windows：按第 10 节拒绝
    entry({ runId: 'ci-201-2-linux', file: 'tests/b.test.mjs', source: 'local' }),
    entry({ runId: 'ci-999-2-linux', file: 'tests/b.test.mjs' }),
    entry({ runId: 'ci-201-1-linux', file: 'tests/b.test.mjs' }),
    entry({ runId: 'ci-201-2-linux', file: 'tests/b.test.mjs', at: 'not a time' }),
    entry({ runId: 'ci-201-2-linux', file: 'tests/b.test.mjs', result: 'maybe' }),
    entry({ runId: 'ci-201-2-linux', file: 'tests/b.test.mjs', tests: -3 }),
    entry({ runId: 'ci-201-2-linux', file: 12 }),
  ];
  const gh = fakeGh({ prHead: 'd'.repeat(40), runs: [RUN2], artifacts: { 201: { 'test-ledger-linux/l.jsonl': lines(...good, ...bad) } } });
  const r = cli(root, ['pull', '--pr', '7'], gh.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const got = readLedger(ledgerFile(root)).entries;
  assert.deepEqual(got.map((e) => `${e.runId}|${e.file}`).sort(), ['ci-201-2-linux|null', 'ci-201-2-linux|tests/a.test.mjs']);
  assert.match(r.stdout, /拒绝 8 条/);
});

test('H2 pull 去重：去重键是 (schema, runId, source, file, note)——同一次运行的两条命令级记录（file 为 null、note 不同）都保留，再拉一次不重复', async () => {
  const { mergeEntries, readLedger, ledgerFile } = await lib();
  const cmd = (note) => entry({ runId: 'ci-301-1-linux', file: null, layer: '未分层', result: 'fail', note });
  const a = cmd('JUnit 解析失败：r1.xml：标签不完整');
  const b = cmd('JUnit 解析失败：r2.xml：标签不完整');
  assert.equal(mergeEntries([], [a, b]).length, 2, '同 schema、runId、source、file 但 note 不同：都保留');
  assert.equal(mergeEntries([a, b], [a, b]).length, 0, '都已存在：不重复');
  assert.equal(mergeEntries([a], [a, b, b]).length, 1, '本批内同 note 的重复只留一条');
  const root = repoWithTests();
  const gh = fakeGh({ prHead: 'd'.repeat(40), runs: [{ databaseId: 301, attempt: 1, status: 'completed', conclusion: 'failure', name: 'CI' }],
    artifacts: { 301: { 'test-ledger-linux/l.jsonl': lines(a, b) } } });
  for (let i = 0; i < 2; i++) {
    const r = cli(root, ['pull', '--pr', '7'], gh.env);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(readLedger(ledgerFile(root)).entries.length, 2, `第 ${i + 1} 次拉取后仍是 2 条`);
  }
});

test('M4 report：项目没配 testLayers → 提示 未配置 modules.gate.testLayers', () => {
  const root = repoWithTests();
  write(root, 'engineering.config.json', JSON.stringify({ profile: 2, layout: { sourceGlobs: ['src/**/*.mjs'], testGlobs: ['tests/**/*.test.mjs'] } }));
  commitAll(root, 'cfg');
  const file = path.join(tmpDir('ekit-rep-'), 'l.jsonl');
  fs.writeFileSync(file, lines(entry({ runId: 'r1', at: new Date().toISOString() })));
  const r = cli(root, ['report', '--ledger', file]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('未配置 modules.gate.testLayers'), r.stdout);
});

test('M4 report：已跟踪测试文件同时命中多个层级 → 提示 命中多个层级，列出文件名和实际采用的第一个层', () => {
  const root = repoWithTests();
  const testLayers = [{ name: 'first-layer', paths: ['tests/**'] }, { name: 'second-layer', paths: ['tests/a.*'] }];
  write(root, 'engineering.config.json', JSON.stringify({ profile: 2, modules: { gate: { testLayers } }, layout: { sourceGlobs: ['src/**/*.mjs'], testGlobs: ['tests/**/*.test.mjs'] } }));
  commitAll(root, 'cfg');
  const file = path.join(tmpDir('ekit-rep-'), 'l.jsonl');
  fs.writeFileSync(file, lines(entry({ runId: 'r1', file: 'tests/b.test.mjs', layer: 'first-layer', at: new Date().toISOString() })));
  const r = cli(root, ['report', '--ledger', file]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('未配置 modules.gate.testLayers'), '配了就不再提示未配置');
  const rows = r.stdout.split('\n');
  const at = rows.findIndex((l) => l.includes('命中多个层级'));
  assert.ok(at >= 0, r.stdout);
  const segment = rows.slice(at, at + 3).join('\n');
  assert.ok(segment.includes('tests/a.test.mjs'), segment);
  assert.ok(segment.includes('first-layer'), '实际采用第一个命中的层');
});

test('M5 报告：时间窗口内没有条目但给了 testFiles → 仍算出 untriggered，formatReport 输出这些文件；整份台账为空且没有 testFiles 仍输出 台账里还没有数据', async () => {
  const { buildReport, formatReport } = await lib();
  const es = [
    entry({ runId: 'o1', file: 'tests/old.test.mjs', at: ago(40) }),
    entry({ runId: 'o2', file: 'tests/mid.test.mjs', at: ago(20) }),
  ];
  const r = buildReport(es, { now: NOW, sinceDays: 7, testFiles: ['tests/old.test.mjs', 'tests/mid.test.mjs', 'tests/never.test.mjs'] });
  assert.deepEqual(names(r.untriggered).sort(), ['tests/never.test.mjs', 'tests/old.test.mjs']);
  const text = formatReport(r);
  assert.ok(text.includes('tests/old.test.mjs') && text.includes('tests/never.test.mjs'), text);
  assert.match(formatReport(buildReport([], { now: NOW })), /台账里还没有数据/);
});

test('M6 JUnit：属性值里出现原始 <，或 & 后不是合法实体 / 数字引用 → ok: false；合法数字引用被解码', async () => {
  const { parseJUnit } = await lib();
  const root = repoWithTests();
  const wrap = (attr) => `<testsuites><testsuite name="s"><testcase name="t" ${attr}/></testsuite></testsuites>`;
  for (const attr of ['classname="a<b"', 'classname="a & b"', 'classname="x&foo;y"', 'classname="x&#xZZ;"', 'classname="x&;"', "classname='x&amp'"]) {
    const r = parseJUnit(wrap(attr), { root });
    assert.equal(r.ok, false, attr);
    assert.ok(typeof r.error === 'string' && r.error.length > 0, attr);
  }
  for (const attr of ['classname="a&lt;b&gt;&amp;&quot;&apos;"', 'classname="&#123;&#x7B;"']) assert.equal(parseJUnit(wrap(attr), { root }).ok, true, attr);
  assert.deepEqual(parseJUnit(wrap('file="tests/&#x61;.test.mjs"'), { root }).files.map((f) => f.file), ['tests/a.test.mjs'], '&#x61; 解码成 a');
  assert.deepEqual(parseJUnit(wrap('file="tests/&#98;.test.mjs"'), { root }).files.map((f) => f.file), ['tests/b.test.mjs'], '&#98; 解码成 b');
  assert.deepEqual(parseJUnit(wrap('file="&#x41;"'), { root }).files.map((f) => f.file), ['A']);
});

test('M7 条目：退出码非 0 且文件级条目都没失败（含全部跳过的文件）→ 补一条命令级 fail', async () => {
  const { buildEntries } = await lib();
  const skipOnly = [{ path: 'r.xml', text: junit(tc('tests/c.test.mjs', '<skipped/>')) }];
  const mixed = [{ path: 'r.xml', text: junit(tc('tests/c.test.mjs', '<skipped/>') + tc('tests/a.test.mjs')) }];
  for (const reports of [skipOnly, mixed]) {
    const out = buildEntries({ ...BASE_ARGS, exitCode: 1, reports });
    const cmd = out.filter((e) => e.file === null);
    assert.equal(cmd.length, 1, JSON.stringify(out));
    assert.deepEqual([cmd[0].result, cmd[0].note], ['fail', '测试命令失败，但报告里没有失败用例']);
  }
  assert.equal(buildEntries({ ...BASE_ARGS, exitCode: 0, reports: skipOnly }).filter((e) => e.file === null).length, 0, '退出码 0 不补');
});

test('M7 条目：所有报告都解析成功但一个用例都没有 → 记一条命令级条目，result 按退出码，note 含 没有用例', async () => {
  const { buildEntries } = await lib();
  const reports = [{ path: 'r.xml', text: '<testsuites></testsuites>' }, { path: 's.xml', text: '<testsuite name="s"></testsuite>' }];
  for (const [exitCode, result] of [[0, 'pass'], [2, 'fail']]) {
    const out = buildEntries({ ...BASE_ARGS, exitCode, reports });
    assert.equal(out.length, 1, JSON.stringify(out));
    assert.deepEqual([out[0].file, out[0].result], [null, result]);
    assert.match(out[0].note, /没有用例/);
  }
});

test('M9 台账：readLedger 把 ek-coverage/1 也当合法行读出；其他 schema 仍是坏行', async () => {
  const { readLedger } = await lib();
  const file = path.join(tmpDir('ekit-ledger-'), 'l.jsonl');
  fs.writeFileSync(file, lines(entry({ runId: 'r1' }), covEntry(), { schema: 'ek-coverage/2', file: 'x' }));
  const got = readLedger(file);
  assert.deepEqual(got.entries.map((e) => e.schema), ['ek-test-ledger/1', 'ek-coverage/1']);
  assert.deepEqual(got.bad, [3]);
});

test('M9 报告：覆盖率条目不影响通过/失败分类与层级统计；formatReport 的 覆盖率 一节列出每个文件最近一次的行覆盖率', async () => {
  const { buildReport, formatReport } = await lib();
  const base = [
    entry({ runId: 'p1', file: 'tests/a.test.mjs', at: ago(2) }),
    entry({ runId: 'f1', file: 'tests/b.test.mjs', result: 'fail', failures: 1, at: ago(2) }),
    entry({ runId: 'f2', file: 'tests/b.test.mjs', result: 'pass', at: ago(3) }),
  ];
  const cov = [
    covEntry({ runId: 'ci-1-1-coverage', file: 'src/a.mjs', lines: { hit: 9, total: 10 }, at: ago(1) }),
    covEntry({ runId: 'ci-0-1-coverage', file: 'src/a.mjs', lines: { hit: 8, total: 10 }, at: ago(5) }),
    covEntry({ runId: 'ci-1-1-coverage', file: 'src/z.mjs', lines: { hit: 1, total: 4 }, at: ago(1) }),
  ];
  const without = buildReport(base, { now: NOW });
  const withCov = buildReport([...base, ...cov], { now: NOW });
  for (const key of ['alwaysPass', 'alwaysFail', 'flaky', 'layers']) assert.deepEqual(withCov[key], without[key], key);
  const text = formatReport(withCov);
  assert.ok(text.includes('覆盖率'), text);
  assert.ok(text.includes('src/a.mjs') && text.includes('src/z.mjs'), text);
  assert.match(text, /90(\.0+)?%/, '最近一次（90%）');
  assert.match(text, /25(\.0+)?%/);
  assert.doesNotMatch(text, /80(\.0+)?%/, '较早的一次不显示');
});

test('M9 coverage 命令：--out/--run-id/--os 给了 → 按改动文件每个追加一条 ek-coverage/1', () => {
  const root = repoWithTests();
  write(root, 'src/a.mjs', '// a\n');
  write(root, 'src/other.mjs', '// o\n');
  commitAll(root, 'add sources');
  const base = git(root, ['rev-parse', 'HEAD']).trim();
  write(root, 'src/a.mjs', '// a changed\n');
  commitAll(root, 'change a');
  const dir = tmpDir('ekit-cov-');
  const lcovFile = path.join(dir, 'lcov.info');
  fs.writeFileSync(lcovFile, lcov(root));
  const out = path.join(dir, 'cov.jsonl');
  const r = cli(root, ['coverage', '--lcov', lcovFile, '--base', base, '--summary', path.join(dir, 's.md'), '--out', out, '--run-id', 'ci-55-1-coverage', '--os', 'linux']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const rows = readJsonl(out);
  assert.equal(rows.length, 1, '只有 src/a.mjs 改动了');
  const [row] = rows;
  assert.deepEqual([row.schema, row.runId, row.source, row.os, row.file], ['ek-coverage/1', 'ci-55-1-coverage', 'ci', 'linux', 'src/a.mjs']);
  assert.deepEqual(row.lines, { hit: 8, total: 10 });
  assert.deepEqual(row.branches, { hit: 3, total: 4 });
  assert.match(row.commit, /^[0-9a-f]{40}$/);
  assert.ok(Number.isFinite(Date.parse(row.at)));
  const noOut = cli(root, ['coverage', '--lcov', lcovFile, '--base', base, '--summary', path.join(dir, 's2.md')]);
  assert.equal(noOut.status, 0, noOut.stderr);
  assert.equal(readJsonl(out).length, 1, '不给 --out 不写台账');
});

test('M9 pull：合法的覆盖率条目导入台账，来源不合法的覆盖率条目拒绝', async () => {
  const { readLedger, ledgerFile } = await lib();
  const root = repoWithTests();
  const gh = fakeGh({ prHead: 'd'.repeat(40), runs: [RUN2],
    artifacts: { 201: { 'test-ledger-coverage/c.jsonl': lines(covEntry(), covEntry({ file: 'src/b.mjs', source: 'local' })) } } });
  const r = cli(root, ['pull', '--pr', '7'], gh.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(readLedger(ledgerFile(root)).entries.map((e) => `${e.schema}|${e.file}`), ['ek-coverage/1|src/a.mjs']);
  assert.match(r.stdout, /拒绝 1 条/);
});

// ---------- 第 2 轮复审回归（规格第 10 节） ----------

/** 用假 gh 拉一次 PR（运行 201 第 2 次），返回 { r, entries, gh }。artifacts 是产物内相对路径到文本的映射。 */
async function pull201(artifacts, prHead = 'd'.repeat(40)) {
  const { readLedger, ledgerFile } = await lib();
  const root = repoWithTests();
  const gh = fakeGh({ prHead, runs: [RUN2], artifacts: { 201: artifacts } });
  const r = cli(root, ['pull', '--pr', '7'], gh.env);
  const entries = fs.existsSync(ledgerFile(root)) ? readLedger(ledgerFile(root)).entries : [];
  return { r, entries, gh };
}

const GOOD = () => entry({ runId: 'ci-201-2-linux', file: 'tests/a.test.mjs' });

test('R2-1 导入身份：test-ledger-linux 产物里自报 windows 的条目拒绝（产物名后缀决定 os）；windows 产物里自报 windows 的合格', async () => {
  const { r, entries } = await pull201({
    'test-ledger-linux/l.jsonl': lines(GOOD(), entry({ runId: 'ci-201-2-windows', os: 'windows', file: 'tests/b.test.mjs' })),
    'test-ledger-windows/l.jsonl': lines(entry({ runId: 'ci-201-2-windows', os: 'windows', file: 'tests/b.test.mjs' })),
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(entries.map((e) => `${e.runId}|${e.os}|${e.file}`).sort(), ['ci-201-2-linux|linux|tests/a.test.mjs', 'ci-201-2-windows|windows|tests/b.test.mjs']);
  assert.match(r.stdout, /拒绝 1 条/);
});

test('R2-1 导入身份：产物名不认识（other-artifact）整份拒绝；文件不在产物子目录里拒绝', async () => {
  const unknown = await pull201({ 'other-artifact/x.jsonl': lines(GOOD(), GOOD()) });
  assert.equal(unknown.r.status, 0, unknown.r.stderr + unknown.r.stdout);
  assert.equal(unknown.entries.length, 0, '不认识的产物名：整份不导入');
  assert.match(unknown.r.stdout, /拒绝/);
  const loose = await pull201({ 'l.jsonl': lines(GOOD()) });
  assert.equal(loose.r.status, 0, loose.r.stderr + loose.r.stdout);
  assert.equal(loose.entries.length, 0, '文件不在子目录里：拒绝');
  assert.match(loose.r.stdout, /拒绝/);
});

test('R2-1 导入身份：test-ledger-coverage 里出现测试行拒绝；test-ledger-linux 里出现覆盖率行拒绝；各自的合格行仍导入', async () => {
  const { r, entries } = await pull201({
    'test-ledger-coverage/c.jsonl': lines(covEntry(), entry({ runId: 'ci-201-2-coverage', file: 'tests/b.test.mjs' })),
    'test-ledger-linux/l.jsonl': lines(GOOD(), covEntry({ runId: 'ci-201-2-linux', file: 'src/b.mjs' })),
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(entries.map((e) => `${e.schema}|${e.runId}|${e.file}`).sort(), ['ek-coverage/1|ci-201-2-coverage|src/a.mjs', 'ek-test-ledger/1|ci-201-2-linux|tests/a.test.mjs']);
  assert.match(r.stdout, /拒绝 2 条/);
});

test('R2-1 导入身份：runId 只是前缀相同、后缀不同（ci-201-2-linux-x）拒绝', async () => {
  const { r, entries } = await pull201({ 'test-ledger-linux/l.jsonl': lines(GOOD(), entry({ runId: 'ci-201-2-linux-x', file: 'tests/b.test.mjs' })) });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(entries.map((e) => e.runId), ['ci-201-2-linux']);
  assert.match(r.stdout, /拒绝 1 条/);
});

test('R2-1 导入身份：layer 非字符串、note 非字符串、changed 不是字符串数组、commit 不是 40 位十六进制都拒绝；commit 为 null 的合格', async () => {
  const bad = [
    entry({ runId: 'ci-201-2-linux', file: 'tests/b.test.mjs', layer: 5 }),
    entry({ runId: 'ci-201-2-linux', file: 'tests/b.test.mjs', note: 5 }),
    entry({ runId: 'ci-201-2-linux', file: 'tests/b.test.mjs', changed: 'src/x.mjs' }),
    entry({ runId: 'ci-201-2-linux', file: 'tests/b.test.mjs', changed: ['src/x.mjs', 3] }),
    entry({ runId: 'ci-201-2-linux', file: 'tests/b.test.mjs', commit: 'abc123' }),
    entry({ runId: 'ci-201-2-linux', file: 'tests/b.test.mjs', commit: 'g'.repeat(40) }),
  ];
  const { r, entries } = await pull201({ 'test-ledger-linux/l.jsonl': lines(GOOD(), entry({ runId: 'ci-201-2-linux', file: 'tests/c.test.mjs', commit: null }), ...bad) });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(entries.map((e) => e.file).sort(), ['tests/a.test.mjs', 'tests/c.test.mjs']);
  assert.match(r.stdout, /拒绝 6 条/);
});

test('R2-1 导入身份：产物里的坏 JSON 行和未知 schema 行计入 拒绝 N 条，输出里有产物名和 文件名:行号', async () => {
  const text = `${JSON.stringify(GOOD())}\nthis is not json\n${JSON.stringify({ schema: 'other/9', file: 'x' })}\n`;
  const { r, entries } = await pull201({ 'test-ledger-linux/l.jsonl': text });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(entries.length, 1);
  assert.match(r.stdout, /拒绝 2 条/);
  assert.ok(r.stdout.includes('test-ledger-linux'), r.stdout);
  assert.ok(r.stdout.includes('l.jsonl:2') && r.stdout.includes('l.jsonl:3'), r.stdout);
});

test('R2-1 导入身份：合格条目入台账后带可信字段 prHead（等于 gh pr view 给的最终提交），commit 原样保留', async () => {
  const head = '9'.repeat(40);
  const { r, entries } = await pull201({ 'test-ledger-linux/l.jsonl': lines(GOOD()) }, head);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].prHead, head);
  assert.equal(entries[0].commit, 'a'.repeat(40), 'CI 实际检出的提交原样保留');
});

test('R2-2 报告空窗口：台账有历史、窗口内没有记录、没给 testFiles → 不是 empty，windowEmpty 为真，formatReport 第一行是 所选时间窗口内没有测试记录；整份台账为空且没给 testFiles 仍是 台账里还没有数据', async () => {
  const { buildReport, formatReport } = await lib();
  const es = [entry({ runId: 'o1', file: 'tests/old.test.mjs', at: ago(40) })];
  const r = buildReport(es, { now: NOW, sinceDays: 7 });
  assert.notEqual(r.empty, true);
  assert.equal(r.windowEmpty, true);
  const text = formatReport(r);
  assert.match(text.split('\n')[0], /所选时间窗口内没有测试记录/);
  assert.doesNotMatch(text, /台账里还没有数据/);
  const none = buildReport([], { now: NOW });
  assert.equal(none.empty, true);
  assert.match(formatReport(none), /台账里还没有数据/);
});

test('R2-3 JUnit 数字引用：&#X41;（大写 X）、&#1;、&#xFFFE; 判坏；&#9;、&#x41;、&#65;、&#x1F600; 合法并解码', async () => {
  const { parseJUnit } = await lib();
  const root = repoWithTests();
  const wrap = (attr) => `<testsuites><testsuite name="s"><testcase name="t" ${attr}/></testsuite></testsuites>`;
  for (const ref of ['&#X41;', '&#1;', '&#xFFFE;']) {
    const r = parseJUnit(wrap(`classname="x${ref}y"`), { root });
    assert.equal(r.ok, false, ref);
    assert.ok(typeof r.error === 'string' && r.error.length > 0, ref);
  }
  assert.equal(parseJUnit(wrap('classname="a&#9;b"'), { root }).ok, true, '&#9;');
  assert.deepEqual(parseJUnit(wrap('file="&#x41;"'), { root }).files.map((f) => f.file), ['A'], '&#x41;');
  assert.deepEqual(parseJUnit(wrap('file="&#65;"'), { root }).files.map((f) => f.file), ['A'], '&#65;');
  assert.deepEqual(parseJUnit(wrap('file="&#x1F600;"'), { root }).files.map((f) => f.file), ['\u{1F600}'], '&#x1F600;');
});
