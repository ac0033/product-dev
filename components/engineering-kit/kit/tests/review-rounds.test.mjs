// 轮次收口纯函数测试（含 0.10.1 的最后一轮口径、风险登记格式、白名单）：roundState、admitRegistration、nextHint、expectedRiskEntries、parseRiskRegister、closureProblems（A6–A14、A10b、“已修”证据）。
// 表驱动：不碰 fs、git、gh；entries 就是 PR 的 log.jsonl 行。文案只按关键词匹配，不绑定整句。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as RR from '../gate/review-rounds.mjs';
import { FINAL_ROUND_TEXT, admitRegistration, closureProblems, expectedRiskEntries, nextHint, parseRiskRegister, roundState } from '../gate/review-rounds.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const E = 'e'.repeat(40);
const CLOSURE = 'fix-and-record';
const NL = String.fromCharCode(10);

/** 登记历史里的发现（compactFindings 口径）；id 的首字母决定级别。 */
function f(id, over = {}) {
  const severity = { H: 'high', M: 'medium', L: 'low', I: 'info' }[id[0]];
  return { id, severity, files: [], unresolvable: false, systemic: false, prior: null, ...over };
}
/** 一条登记。 */
const rec = (kind, verdict, headSha, findings = [], extra = {}) => ({ kind, verdict, headSha, findings, userDecision: null, ...extra });
const fail = (kind, head, findings) => rec(kind, 'fail', head, findings);
const pass = (kind, head) => rec(kind, 'pass', head);
/** 一轮收齐：代码复审 fail，一致性审 pass。 */
const roundHigh = (head) => [fail('code', head, [f('H1'), f('M1')]), pass('consistency', head)];
const roundMid2 = (head) => [fail('code', head, [f('M1'), f('M2')]), pass('consistency', head)];
const roundMid1 = (head) => [fail('code', head, [f('M1')]), pass('consistency', head)];

const rs = (entries, { limit = 2, closure = CLOSURE } = {}) => roundState({ entries, limit, closure });
const text = (s) => [...(s.reasons ?? []), ...s.rounds.flatMap((r) => r.systemicWhy ?? [])].join('|');

// ---------- roundState ----------

test('A11 roundState：closure 为 off 时 phase 是 off，其余字段照算', () => {
  const s = rs([...roundHigh(A), ...roundHigh(B), ...roundHigh(C)], { closure: 'off' });
  assert.equal(s.phase, 'off');
  assert.equal(s.rounds.length, 3);
  assert.equal(s.latest.head, C);
});

test('A6 roundState：没有 fail 登记时是 open，latest 为 null', () => {
  for (const entries of [[], [pass('code', A)], [pass('code', A), pass('consistency', A)]]) {
    const s = rs(entries);
    assert.equal(s.phase, 'open');
    assert.equal(s.rounds.length, 0);
    assert.equal(s.latest, null);
    assert.equal(s.finalHead, null);
  }
});

test('A13 roundState：最新一轮未收齐是 collecting，写明缺哪种；defer 与 accept 算收齐', () => {
  const noCons = rs([fail('code', A, [f('M1')])]);
  assert.equal(noCons.phase, 'collecting');
  assert.deepEqual(noCons.latest.missingKinds, ['consistency']);
  assert.equal(noCons.latest.collected, false);
  assert.ok(noCons.reasons.length > 0);
  const noCode = rs([fail('consistency', A, [f('M1')])]);
  assert.equal(noCode.phase, 'collecting');
  assert.deepEqual(noCode.latest.missingKinds, ['code']);
  const deferred = rs([fail('code', A, [f('M1')]), rec('consistency', 'defer', A)]);
  assert.equal(deferred.latest.collected, true);
  assert.deepEqual(deferred.latest.missingKinds, []);
  assert.equal(deferred.phase, 'open');
  const accepted = rs([fail('code', A, [f('M1')]), rec('consistency', 'accept', A, [], { userDecision: '用户接受' })]);
  assert.equal(accepted.latest.collected, true);
});

test('A13 roundState：未收齐时先 collecting，不因 unresolvable 提前 stop；收齐后才判定', () => {
  const s = rs([fail('code', A, [f('M1', { unresolvable: true })])]);
  assert.equal(s.phase, 'collecting');
  const done = rs([fail('code', A, [f('M1', { unresolvable: true })]), pass('consistency', A)]);
  assert.equal(done.phase, 'stop', '迟到的那份收齐后照样参与判定');
});

test('A6 roundState：第 1 轮收齐且 r < N 是 open，rounds 记录每轮的提交、收齐、计数', () => {
  const s = rs(roundHigh(A));
  assert.equal(s.phase, 'open');
  assert.equal(s.rounds.length, 1);
  assert.equal(s.rounds[0].head, A);
  assert.equal(s.rounds[0].collected, true);
  assert.deepEqual(s.rounds[0].counts, { high: 1, medium: 1 });
  assert.equal(s.rounds[0].high, true);
});

test('A7 roundState：第 N 轮收齐且有高级是 final-next，finalHead 未定', () => {
  const s = rs([...roundHigh(A), ...roundHigh(B)]);
  assert.equal(s.phase, 'final-next');
  assert.equal(s.finalHead, null);
  assert.equal(s.latest.head, B);
});

test('A6 roundState：第 N 轮收齐且没有高级是 close-only', () => {
  const s = rs([...roundMid2(A), ...roundMid1(B)]);
  assert.equal(s.phase, 'close-only');
  assert.equal(s.finalHead, null);
});

test('A7 roundState：finalHead 是第 N 轮之后第一个别的提交上的 pass 或 fail', () => {
  const afterPass = rs([...roundHigh(A), ...roundHigh(B), pass('code', C)]);
  assert.equal(afterPass.phase, 'final-next');
  assert.equal(afterPass.finalHead, C);
  const afterFail = rs([...roundHigh(A), ...roundHigh(B), fail('code', D, [f('H1'), f('M1')])]);
  assert.equal(afterFail.finalHead, D);
  const withDefer = rs([...roundHigh(A), ...roundHigh(B), rec('consistency', 'defer', C), pass('code', D)]);
  assert.equal(withDefer.finalHead, D, 'defer 不算 pass 或 fail，不定 finalHead');
});

test('A8 roundState：r = N+1 且是 finalHead：仍有高级是 stop，写明原因', () => {
  const s = rs([...roundHigh(A), ...roundHigh(B), ...roundHigh(C)]);
  assert.equal(s.phase, 'stop');
  assert.equal(s.finalHead, C);
  assert.ok(s.reasons.length > 0);
});

test('A9 roundState：r = N+1 且是 finalHead：只剩中低级是 close-only', () => {
  const s = rs([...roundHigh(A), ...roundHigh(B), fail('code', C, [f('M1'), f('L1')]), pass('consistency', C)]);
  assert.equal(s.phase, 'close-only');
  assert.equal(s.finalHead, C);
});

test('A8 roundState：第 N+1 轮不是 finalHead（先在别的提交上登记过 pass）是 stop', () => {
  const s = rs([...roundHigh(A), ...roundHigh(B), pass('code', C), ...roundHigh(D)]);
  assert.equal(s.finalHead, C);
  assert.equal(s.phase, 'stop');
  assert.ok(s.reasons.length > 0);
});

test('A8 roundState：第 N 轮不是 final-next（只剩中级）就出现第 N+1 轮是 stop', () => {
  const s = rs([...roundMid2(A), ...roundMid1(B), ...roundMid1(C)]);
  assert.equal(s.phase, 'stop');
});

test('A8 roundState：r > N+1 是 stop', () => {
  const s = rs([...roundHigh(A), ...roundHigh(B), ...roundHigh(C), ...roundHigh(D)]);
  assert.equal(s.rounds.length, 4);
  assert.equal(s.phase, 'stop');
});

test('A10 roundState：系统性问题四种判据与 unresolvable 各自进入 stop，并写明原因', () => {
  const cases = [
    ['高、中级发现带 prior', [fail('code', A, [f('M1', { prior: 'M1' })]), pass('consistency', A)], 'systemic'],
    ['发现自带 systemic 标志', [fail('code', A, [f('M1'), f('L1', { systemic: true })]), pass('consistency', A)], 'systemic'],
    ['上一轮没有高级、本轮出现高级', [...roundMid1(A), fail('code', B, [f('H1'), f('M1')]), pass('consistency', B)], 'systemic'],
    ['中级数量比上一轮多', [...roundMid1(A), ...roundMid2(B)], 'systemic'],
    ['高级数量比上一轮多', [fail('code', A, [f('H1'), f('M1')]), pass('consistency', A), fail('code', B, [f('H1'), f('H2'), f('M1')]), pass('consistency', B)], 'systemic'],
    ['发现 unresolvable', [fail('code', A, [f('M1', { unresolvable: true })]), pass('consistency', A)], 'unresolvable'],
  ];
  for (const [name, entries, flag] of cases) {
    const s = rs(entries, { limit: 3 });
    assert.equal(s.phase, 'stop', name);
    assert.equal(s.latest[flag], true, `${name}：latest.${flag}`);
    assert.ok(s.reasons.length > 0, `${name}：reasons 写明原因`);
    if (flag === 'systemic') assert.ok(s.latest.systemicWhy.length > 0, `${name}：systemicWhy 写明命中哪条`);
  }
});

test('A10 roundState：四种判据各自的反例不触发（低级 prior、数量不增、第一轮就有高级、低级数量增加）', () => {
  const cases = [
    ['低级发现带 prior', [fail('code', A, [f('M1'), f('L1', { prior: 'L1' })]), pass('consistency', A)]],
    ['第一轮就有高级（没有上一轮可比）', roundHigh(A)],
    ['数量没有增加', [...roundMid2(A), ...roundMid1(B)]],
    ['低级数量增加不算', [fail('code', A, [f('M1'), f('L1')]), pass('consistency', A), fail('code', B, [f('M1'), f('L1'), f('L2')]), pass('consistency', B)]],
  ];
  for (const [name, entries] of cases) {
    const s = rs(entries, { limit: 3 });
    assert.equal(s.latest.systemic, false, `${name}：${text(s)}`);
    assert.notEqual(s.phase, 'stop', name);
  }
});

test('A10 roundState：计数只取每种审查在该提交上最后一条 fail，两种审查合计', () => {
  const redo = rs([fail('code', A, [f('M1'), f('M2')]), fail('code', A, [f('M1')]), pass('consistency', A)]);
  assert.deepEqual(redo.rounds[0].counts, { high: 0, medium: 1 }, '同一提交上代码复审登记两次 fail，只数最后一条');
  assert.equal(redo.rounds.length, 1, '同一提交上多次 fail 仍是一轮');
  const both = rs([fail('code', A, [f('H1')]), fail('consistency', A, [f('M1'), f('M2')])]);
  assert.deepEqual(both.rounds[0].counts, { high: 1, medium: 2 });
  assert.equal(both.rounds[0].collected, true);
});

test('A12 roundState：忽略 kind 为 close 的行', () => {
  const closeRow = { kind: 'close', verdict: 'close', headSha: C, failHead: B, round: 2, entries: 1 };
  const s = rs([...roundMid2(A), ...roundMid1(B), closeRow]);
  assert.equal(s.rounds.length, 2);
  assert.equal(s.phase, 'close-only');
  assert.equal(s.finalHead, null, 'close 行不定 finalHead');
});

// ---------- admitRegistration ----------

const open = () => rs(roundMid1(A));
const collecting = () => rs([fail('code', A, [f('M1')])]);
const closeOnly = () => rs([...roundMid2(A), ...roundMid1(B)]);
const finalNext = () => rs([...roundHigh(A), ...roundHigh(B)]);
const finalNextSet = () => rs([...roundHigh(A), ...roundHigh(B), pass('code', C)]);
const stop = () => rs([...roundHigh(A), ...roundHigh(B), ...roundHigh(C)]);
const DECISION = '用户 2026-11-26 在对话中同意继续';
const admit = (state, over) => admitRegistration(state, { verdict: 'pass', kind: 'code', head: E, userDecision: null, ...over });

test('A10b admitRegistration：accept、有内容的 userDecision 在任何阶段恒放行；defer 除收齐前之外放行（收齐前见 A13）', () => {
  for (const [name, state] of [['collecting', collecting()], ['close-only', closeOnly()], ['final-next', finalNext()], ['stop', stop()]]) {
    assert.equal(admit(state, { verdict: 'accept' }), null, `${name} accept`);
    if (name !== 'collecting') assert.equal(admit(state, { verdict: 'defer', kind: 'consistency' }), null, `${name} defer`);
    for (const verdict of ['pass', 'fail']) assert.equal(admit(state, { verdict, userDecision: DECISION }), null, `${name} ${verdict} 带用户决定`);
  }
  assert.equal(typeof admit(stop(), { userDecision: '   ' }), 'string', '空白的用户决定不算');
});

test('A6 admitRegistration：open 与 off 放行', () => {
  for (const verdict of ['pass', 'fail']) assert.equal(admit(open(), { verdict }), null);
  assert.equal(admit(rs([], {}), {}), null);
});

test('A13 admitRegistration：collecting 只放行最新提交上缺的那种审查', () => {
  const s = collecting();
  for (const verdict of ['pass', 'fail']) assert.equal(admit(s, { verdict, kind: 'consistency', head: A }), null, `缺的那种 ${verdict}`);
  const wrongKind = admit(s, { kind: 'code', head: A });
  assert.equal(typeof wrongKind, 'string', '该提交上已有的那种不放行');
  const newHead = admit(s, { kind: 'consistency', head: E });
  assert.equal(typeof newHead, 'string', '新提交上的登记不放行');
  assert.ok(newHead.includes(A.slice(0, 12)), '写明要在哪个提交上补登');
});

test('A6 admitRegistration：close-only 拒绝 pass、fail，文字指向 close', () => {
  for (const verdict of ['pass', 'fail']) {
    const r = admit(closeOnly(), { verdict });
    assert.equal(typeof r, 'string');
    assert.match(r, /close/);
  }
});

test('A7 admitRegistration：final-next 且 finalHead 未定时，新提交放行、旧提交拒绝', () => {
  const s = finalNext();
  for (const verdict of ['pass', 'fail']) assert.equal(admit(s, { verdict, head: E }), null);
  assert.equal(typeof admit(s, { head: B }), 'string', '最新一轮的提交不是新提交');
});

test('A7 admitRegistration：finalHead 已定时只认 finalHead，同种审查不能登两次', () => {
  const s = finalNextSet();
  assert.equal(s.finalHead, C);
  assert.equal(admit(s, { kind: 'consistency', head: C }), null, '该提交上还没有的那种放行');
  assert.equal(admit(s, { kind: 'consistency', verdict: 'fail', head: C }), null);
  const twice = admit(s, { kind: 'code', head: C });
  assert.equal(typeof twice, 'string', '代码复审在 finalHead 上已登记过');
  const other = admit(s, { kind: 'consistency', head: E });
  assert.equal(typeof other, 'string');
  assert.match(other, /--user-decision/);
  assert.ok(other.includes(C.slice(0, 12)), '写明只认哪个提交');
});

test('A8 admitRegistration：stop 拒绝 pass、fail，文字含停下与 --user-decision', () => {
  for (const verdict of ['pass', 'fail']) {
    const r = admit(stop(), { verdict });
    assert.equal(typeof r, 'string');
    assert.match(r, /停下/);
    assert.match(r, /--user-decision/);
  }
});

// ---------- nextHint ----------

test('A7 nextHint：final-next 且 finalHead 未定提示最后一轮；close-only 提示 close；stop 提示停下', () => {
  assert.match(nextHint(finalNext()), /最后一轮/);
  assert.match(nextHint(closeOnly()), /close/);
  assert.match(nextHint(stop()), /停下/);
});

test('A7 nextHint：其余阶段没有提示（open、collecting、off、finalHead 已定）', () => {
  for (const s of [open(), collecting(), finalNextSet(), rs([], {}), rs(roundHigh(A), { closure: 'off' })]) assert.equal(nextHint(s), null);
});

test('A7 FINAL_ROUND_TEXT：写明最后一轮、彻底解决办法、unresolvable', () => {
  assert.equal(typeof FINAL_ROUND_TEXT, 'string');
  for (const word of ['最后一轮', '彻底', 'unresolvable']) assert.ok(FINAL_ROUND_TEXT.includes(word), word);
});

// ---------- 风险登记 ----------

const full = (id, over = {}) => ({
  id,
  severity: { H: 'high', M: 'medium', L: 'low', I: 'info' }[id[0]],
  location: `src/dedup.ts:${id}`,
  problem: `问题 ${id}`,
  trigger: `触发 ${id}`,
  reason: `理由 ${id}`,
  fix: `改法 ${id}`,
  files: ['src/dedup.ts'],
  ...over,
});
const STATUS = '已修、未再复审';

const SHA = 'f'.repeat(64);
/** 0.10.1 的风险登记条目（只存编号、指纹和摘要）。 */
const newEntry = (over = {}) => ({ pr: '7', commit: B, round: 2, kind: 'code', id: 'M1', severity: 'medium', status: STATUS, fixedIn: [], dataSha: SHA, findingSha: SHA, summary: '已核对的摘要', ...over });
/** 0.10.0 的旧格式条目（含原文，没有指纹和摘要）。 */
const legacyEntry = (over = {}) => ({ pr: '7', commit: B, round: 2, kind: 'code', id: 'M1', severity: 'medium', location: 'src/dedup.ts:1', problem: '问题', reason: '理由', fix: '改法', status: STATUS, fixedIn: [], ...over });

test('P7 findingFingerprint = sha256 hex(canonicalJson(finding))：键顺序不影响，内容变一个字就变（0.10.1 代码 H2）', async () => {
  assert.equal(typeof RR.findingFingerprint, 'function', 'review-rounds.mjs 应导出 findingFingerprint');
  const a = full('M1');
  const reordered = Object.fromEntries(Object.entries(a).reverse());
  assert.match(RR.findingFingerprint(a), /^[0-9a-f]{64}$/);
  assert.equal(RR.findingFingerprint(a), RR.findingFingerprint(reordered), '键顺序不同、内容相同，指纹相同');
  assert.notEqual(RR.findingFingerprint(a), RR.findingFingerprint({ ...a, problem: `${a.problem}。` }));
  const lib = await import('../gate/review-data.mjs');
  if (typeof lib.canonicalJson === 'function') {
    const { createHash } = await import('node:crypto');
    assert.equal(RR.findingFingerprint(a), createHash('sha256').update(lib.canonicalJson(a)).digest('hex'));
  }
});

test('P7 expectedRiskEntries：条目键恰好是 pr、commit、round、kind、id、severity、status、fixedIn、dataSha、findingSha、summary；只取中级，summary 为 null，dataSha 取失败登记的副本指纹，原文不进条目（0.10.1 代码 H2；原 A12 同名用例）', () => {
  const failures = [
    { kind: 'code', findings: [full('H1'), full('M1'), full('L1'), full('I1')], dataSha: '1'.repeat(64) },
    { kind: 'consistency', findings: [full('M1'), full('M2')], dataSha: '2'.repeat(64) },
  ];
  const entries = expectedRiskEntries({ pr: '7', round: 2, failHead: B, failures });
  assert.equal(entries.length, 3, '只取 medium，两种审查同号各一条');
  for (const e of entries) {
    assert.deepEqual(Object.keys(e).sort(), ['commit', 'dataSha', 'findingSha', 'fixedIn', 'id', 'kind', 'pr', 'round', 'severity', 'status', 'summary']);
    assert.equal(e.summary, null);
    assert.equal(e.status, STATUS);
    assert.equal(e.severity, 'medium');
    assert.deepEqual(e.fixedIn, []);
    assert.equal(e.pr, '7');
    assert.equal(e.commit, B);
    assert.equal(e.round, 2);
  }
  assert.deepEqual(entries.map((e) => [e.kind, e.id]), [['code', 'M1'], ['consistency', 'M1'], ['consistency', 'M2']]);
  assert.deepEqual(entries.map((e) => e.dataSha), ['1'.repeat(64), '2'.repeat(64), '2'.repeat(64)]);
  assert.equal(entries[0].findingSha, RR.findingFingerprint(full('M1')));
  assert.equal(entries[2].findingSha, RR.findingFingerprint(full('M2')));
  const text = JSON.stringify(entries);
  for (const secret of ['src/dedup.ts:M1', '问题 M1', '理由 M1', '改法 M1']) assert.ok(!text.includes(secret), `${secret} 不进风险登记条目`);
  assert.deepEqual(expectedRiskEntries({ pr: '7', round: 1, failHead: A, failures: [{ kind: 'code', findings: [full('H1'), full('L1')], dataSha: SHA }] }), []);
});

test('P7 parseRiskRegister：新格式合法、空行跳过；旧格式（0.10.0）合法但标 legacy（0.10.1 代码 H2；原 A12 同名用例）', () => {
  const n = newEntry();
  const l = legacyEntry({ id: 'M2' });
  const r = parseRiskRegister([JSON.stringify(n), '', JSON.stringify(l), ''].join(NL));
  assert.deepEqual(r.problems, []);
  assert.equal(r.entries.length, 2);
  const { legacy, ...plain } = r.entries[0];
  assert.ok(!legacy, '新格式不是旧格式');
  assert.deepEqual(plain, n);
  assert.equal(r.entries[1].legacy, true, '旧格式标 legacy');
});

test('P7 parseRiskRegister：坏行按行号报（不是 JSON、不是对象、缺键、多键、混合键、类型不对）（0.10.1 代码 H2；原 A12 同名用例）', () => {
  const n = newEntry();
  const l = legacyEntry({ id: 'M2' });
  const bads = {
    '坏 JSON': '{ 坏的',
    数组: '[]',
    数字: '5',
    '新格式缺 fixedIn': JSON.stringify((({ fixedIn, ...rest }) => rest)(n)),
    '新格式缺 summary': JSON.stringify((({ summary, ...rest }) => rest)(n)),
    '新格式多键': JSON.stringify({ ...n, extra: 1 }),
    '新旧混合键': JSON.stringify({ ...n, location: 'src/a.ts:1' }),
    '旧格式缺键': JSON.stringify((({ fix, ...rest }) => rest)(l)),
    '旧格式多键': JSON.stringify({ ...l, extra: 1 }),
    'fixedIn 不是数组': JSON.stringify({ ...n, fixedIn: 'src/a.ts' }),
    'round 不是数字': JSON.stringify({ ...n, round: '2' }),
    'summary 不是字符串': JSON.stringify({ ...n, summary: 5 }),
  };
  for (const [name, line] of Object.entries(bads)) {
    const r = parseRiskRegister([JSON.stringify(n), '', line].join(NL));
    assert.equal(r.problems.length, 1, `${name}：${JSON.stringify(r.problems)}`);
    assert.match(r.problems[0], /3/, `${name}：按行号报（第 3 行）`);
  }
});

// ---------- closureProblems ----------

const FAIL_FINDING = full('M1');
const DATA_SHA = 'd'.repeat(64);
const SUMMARY = '已核对的可共享摘要';
/** 满足全部前提的事实：第 N 轮（B）只剩中级，修复提交改了定位文件，风险登记完整。 */
function goodFacts(over = {}) {
  const state = closeOnly();
  const expected = expectedRiskEntries({ pr: '7', round: 2, failHead: B, failures: [{ kind: 'code', findings: [FAIL_FINDING], dataSha: DATA_SHA }] });
  return {
    closure: CLOSURE,
    flow: 'pr',
    prOpen: true,
    ciProblems: [],
    state,
    head: E,
    failHead: B,
    headIsDescendant: true,
    register: { entries: expected.map((x) => ({ ...x, summary: SUMMARY })), problems: [] },
    expected,
    fixDiff: ['src/dedup.ts'],
    registerPath: 'docs/04-开发/review-risks.jsonl',
    ...over,
  };
}
const all = (facts) => closureProblems(facts).join('|');
const withEntry = (over) => {
  const g = goodFacts();
  return { register: { entries: [{ ...g.expected[0], summary: SUMMARY, ...over }], problems: [] } };
};

test('A12 closureProblems：前提都满足时返回空数组', () => {
  assert.deepEqual(closureProblems(goodFacts()), []);
});

test('A12 closureProblems：开关、流程、PR 状态、CI、阶段、提交关系各自不满足时报出', () => {
  const cases = [
    ['开关关闭', { closure: 'off' }, /./],
    ['不是 pr 流程', { flow: 'pre-push' }, /./],
    ['PR 不是打开状态', { prOpen: false }, /./],
    ['CI 有问题', { ciProblems: ['检查 test 未通过'] }, /检查 test 未通过/],
    ['阶段是 open', { state: open() }, /open/],
    ['阶段是 stop', { state: stop() }, /stop/],
    ['最终提交就是最新失败提交', { head: B }, /./],
    ['最终提交不是失败提交的后代', { headIsDescendant: false }, /./],
  ];
  for (const [name, over, pattern] of cases) {
    const out = closureProblems(goodFacts(over));
    assert.ok(out.length >= 1, name);
    assert.match(out.join('|'), pattern, name);
  }
});

test('A12 closureProblems：多个前提同时不满足时全部列出，不在第一条停', () => {
  const out = closureProblems(goodFacts({ closure: 'off', prOpen: false, ciProblems: ['CI 红了'], headIsDescendant: false, head: B, register: null }));
  assert.ok(out.length >= 5, JSON.stringify(out));
  assert.match(out.join('|'), /CI 红了/);
  assert.match(out.join('|'), /review-risks/, '登记文件不存在也列出');
});

test('A12 closureProblems：风险登记文件不存在、有坏行、条目缺失各自报出', () => {
  const g = goodFacts();
  assert.match(all(goodFacts({ register: null })), /review-risks/);
  assert.match(all(goodFacts({ register: { entries: g.register.entries, problems: ['第 2 行：不是合法条目'] } })), /第 2 行/);
  assert.match(all(goodFacts({ register: { entries: [], problems: [] } })), /M1/);
  assert.match(all(goodFacts(withEntry({ id: 'M9' }))), /M1/, '只有别的编号的条目等于条目缺失');
  assert.ok(all(goodFacts(withEntry({ pr: '8' }))).length > 0, '身份（pr）不同视为缺失');
  assert.ok(all(goodFacts(withEntry({ commit: A }))).length > 0, '身份（commit）不同');
  assert.ok(all(goodFacts(withEntry({ round: 1 }))).length > 0, '身份（round）不同');
  assert.ok(all(goodFacts(withEntry({ kind: 'consistency' }))).length > 0, '身份（kind）不同');
});

test('A12 closureProblems：文本只差一个字符、状态不对都报出，并点名编号', () => {
  for (const field of ['severity', 'dataSha', 'findingSha']) {
    const g = goodFacts();
    const changed = field === 'severity' ? 'high' : `${g.expected[0][field].slice(0, -1)}0`;
    assert.match(all(goodFacts(withEntry({ [field]: changed }))), /M1/, field);
  }
  assert.match(all(goodFacts(withEntry({ findingSha: RR.findingFingerprint({ ...FAIL_FINDING, problem: '间题 M1' }) }))), /M1/, '发现文字只差一个字，指纹就对不上');
  assert.match(all(goodFacts(withEntry({ status: '已修' }))), /M1/, '状态不对');
});

test('A12 closureProblems：同一身份出现两条报出', () => {
  const g = goodFacts();
  assert.match(all(goodFacts({ register: { entries: [g.register.entries[0], { ...g.register.entries[0] }], problems: [] } })), /M1/);
});

test('A12 closureProblems：登记文件里期望之外的条目不影响', () => {
  const g = goodFacts();
  const extra = { ...g.register.entries[0], id: 'M7', commit: A, round: 1 };
  assert.deepEqual(closureProblems(goodFacts({ register: { entries: [extra, g.register.entries[0]], problems: [] } })), []);
});

test('A12 “已修”证据：发现有 files 且命中修复差异时成立，不要求 fixedIn', () => {
  assert.deepEqual(closureProblems(goodFacts({ fixDiff: ['src/dedup.ts', 'src/other.ts'], exempt: (file) => file === 'src/other.ts' })), [], '其余文件要在白名单里（0.10.1 W6：这里用 exempt 放行）');
  const expected = expectedRiskEntries({ pr: '7', round: 2, failHead: B, failures: [{ kind: 'code', findings: [{ ...FAIL_FINDING, files: ['src/x.ts', 'src/dedup.ts'] }], dataSha: DATA_SHA }] });
  assert.deepEqual(closureProblems(goodFacts({ expected, register: { entries: expected.map((x) => ({ ...x, summary: SUMMARY })), problems: [] } })), [], '至少一个命中即可');
});

test('A12 “已修”证据：有 files 未命中但 fixedIn 非空且都在修复差异里时成立', () => {
  const g = goodFacts({ fixDiff: ['src/other.ts', 'src/more.ts'] });
  g.register = { entries: [{ ...g.expected[0], summary: SUMMARY, fixedIn: ['src/other.ts', 'src/more.ts'] }], problems: [] };
  assert.deepEqual(closureProblems(g), []);
});

test('A12 “已修”证据：有 files 都不命中，且 fixedIn 为空、不在差异里或只有一部分在，都报“都不在修复差异里”', () => {
  for (const [name, fixedIn] of [['fixedIn 为空', []], ['fixedIn 不在差异里', ['src/elsewhere.ts']], ['fixedIn 只有一部分在差异里', ['src/other.ts', 'src/elsewhere.ts']]]) {
    const g = goodFacts({ fixDiff: ['src/other.ts'] });
    g.register = { entries: [{ ...g.expected[0], summary: SUMMARY, fixedIn }], problems: [] };
    const out = closureProblems(g).join('|');
    assert.match(out, /M1/, name);
    assert.ok(out.includes('src/dedup.ts'), `${name}：写明定位文件`);
    assert.match(out, /修复差异/, name);
  }
  assert.match(closureProblems(goodFacts({ fixDiff: [] })).join('|'), /修复差异/, '修复差异为空');
});

test('A12 “已修”证据：发现没有 files 时 fixedIn 必须非空且都在修复差异里', () => {
  const noFiles = { ...FAIL_FINDING, files: [] };
  const expected = expectedRiskEntries({ pr: '7', round: 2, failHead: B, failures: [{ kind: 'code', findings: [noFiles], dataSha: DATA_SHA }] });
  const mk = (fixedIn, fixDiff) => goodFacts({ expected, fixDiff, register: { entries: [{ ...expected[0], summary: SUMMARY, fixedIn }], problems: [] } });
  assert.match(closureProblems(mk([], ['src/dedup.ts'])).join('|'), /修复差异/, 'fixedIn 为空');
  assert.match(closureProblems(mk(['src/elsewhere.ts'], ['src/dedup.ts'])).join('|'), /修复差异/, 'fixedIn 不在差异里');
  assert.match(closureProblems(mk(['src/dedup.ts', 'src/elsewhere.ts'], ['src/dedup.ts'])).join('|'), /修复差异/, '只有一部分在差异里');
  assert.deepEqual(closureProblems(mk(['src/dedup.ts'], ['src/dedup.ts'])), []);
  const noKey = { ...FAIL_FINDING };
  delete noKey.files;
  const expectedNoKey = expectedRiskEntries({ pr: '7', round: 2, failHead: B, failures: [{ kind: 'code', findings: [noKey], dataSha: DATA_SHA }] });
  assert.match(closureProblems(goodFacts({ expected: expectedNoKey, register: { entries: expectedNoKey.map((x) => ({ ...x, summary: SUMMARY })), problems: [] } })).join('|'), /修复差异/, '没有 files 键同样处理');
});


// ---------- PR #43 第 1 轮复审的回归 ----------

test('A7 roundState：最后一轮从第 N 轮收齐之后算起；收齐前经用户同意在别的提交上的登记不占用最后一轮（PR #43 代码 M1、一致性 M3）', () => {
  const early = rec('code', 'pass', C, [], { userDecision: '用户同意先在 C 上登记' });
  const s = rs([...roundHigh(A), fail('code', B, [f('H1'), f('M1')]), early, pass('consistency', B)]);
  assert.equal(s.phase, 'final-next');
  assert.equal(s.finalHead, null, '收齐前的例外登记不算最后一轮');
  const later = rs([...roundHigh(A), fail('code', B, [f('H1'), f('M1')]), early, pass('consistency', B), pass('code', D)]);
  assert.equal(later.finalHead, D, '收齐后第一个别的提交才是最后一轮');
});

test('A10 roundState：同一轮里通过的那份报告带无法彻底解决或系统性标记（哪怕是低级）也停下（PR #43 代码 M3、一致性 M2）', () => {
  const unresolvable = rs([fail('code', A, [f('M1')]), rec('consistency', 'pass', A, [f('L1', { unresolvable: true })])]);
  assert.equal(unresolvable.phase, 'stop');
  assert.match(text(unresolvable), /无法彻底解决/);
  const systemic = rs([fail('code', A, [f('M1')]), rec('consistency', 'pass', A, [f('L1', { systemic: true })])]);
  assert.equal(systemic.phase, 'stop');
  assert.match(text(systemic), /系统性/);
  const counts = rs([fail('code', A, [f('M1')]), rec('consistency', 'pass', A, [f('L1')])]);
  assert.deepEqual(counts.latest.counts, { high: 0, medium: 1 }, '数量只数高、中级');
});

test('A13 admitRegistration：收齐前一致性审的延期也只能登记在缺它的那个提交上，别的提交要用户决定（PR #43 一致性 M5）', () => {
  const s = rs([fail('code', A, [f('M1')])]);
  assert.equal(s.phase, 'collecting');
  assert.equal(admitRegistration(s, { verdict: 'defer', kind: 'consistency', head: A, userDecision: null }), null, '在缺它的提交上延期放行');
  assert.equal(typeof admitRegistration(s, { verdict: 'defer', kind: 'consistency', head: B, userDecision: null }), 'string', '在别的提交上延期要用户决定');
  assert.equal(admitRegistration(s, { verdict: 'defer', kind: 'consistency', head: B, userDecision: '用户同意' }), null);
});

// ---------- PR #43 第 2 轮复审的回归 ----------

test('A7 roundState：第 N 轮的收齐位置以该提交首次不通过为下界；更早在别的提交上的登记不占用最后一轮（PR #43 第 2 轮代码 M1、一致性 M1）', () => {
  // B 先有两份通过，PR 到过 C，又回到 B 首次登记不通过：B 在那一刻收齐（之前的通过照算），C 的登记在它之前
  const s = rs([...roundHigh(A), pass('code', B), pass('consistency', B), pass('code', C), fail('code', B, [f('H1'), f('M1')])]);
  assert.equal(s.latest.head, B);
  assert.equal(s.phase, 'final-next');
  assert.equal(s.finalHead, null, 'B 首次不通过之前的登记不算最后一轮');
});

test('A7 roundState：最后一轮已登记的种类只算第 N 轮收齐之后的登记；收齐前（经用户同意）在同一提交上的登记不顶替最后一轮的审查（PR #43 第 2 轮代码 M1、一致性 M1）', () => {
  const early = rec('consistency', 'pass', C, [], { userDecision: '用户同意先在 C 上登记' });
  const s = rs([...roundHigh(A), fail('code', B, [f('H1'), f('M1')]), early, pass('consistency', B), pass('code', C)]);
  assert.equal(s.finalHead, C);
  assert.deepEqual(s.finalKinds, ['code'], '收齐前那份一致性审不算最后一轮已登记');
  assert.equal(admitRegistration(s, { verdict: 'pass', kind: 'consistency', head: C, userDecision: null }), null, '最后一轮的一致性审照常放行');
});

test('A12 admitRegistration：收口阶段里某种审查只是部分覆盖时，放行在失败提交上补一份同种复审（补齐覆盖），别的登记照旧指向 close（PR #43 第 2 轮代码 M2、一致性 M2）', () => {
  const s = rs([fail('code', A, [f('M1')]), pass('consistency', A), rec('code', 'fail', B, [f('M1')], { coverage: 'partial' }), rec('consistency', 'pass', B, [], { coverage: 'full' })]);
  assert.equal(s.phase, 'close-only');
  assert.equal(admitRegistration(s, { verdict: 'fail', kind: 'code', head: B, userDecision: null }), null, '在失败提交上补完整覆盖的代码复审');
  assert.match(String(admitRegistration(s, { verdict: 'pass', kind: 'consistency', head: B, userDecision: null })), /close/, '已完整覆盖的那种不再放行');
  assert.match(String(admitRegistration(s, { verdict: 'pass', kind: 'code', head: C, userDecision: null })), /close/, '别的提交不放行');
});

// ---------- 0.10.1：最后一轮的口径（代码 M5、一致性 M2） ----------

const EARLY = '用户同意在 B 上先登记（收齐之前）';
/** R1 的登记历史：limit 2；第 1 轮 C 收齐有高级；第 2 轮 A 代码 fail；A 收齐前经用户决定在 B 登记一致性审 pass；A 补一致性审收齐；收齐之后在 B 登记代码 fail（只有 M1）。 */
const r1Entries = (tail = []) => [
  ...roundHigh(C),
  fail('code', A, [f('H1'), f('M1')]),
  rec('consistency', 'pass', B, [], { userDecision: EARLY }),
  pass('consistency', A),
  fail('code', B, [f('M1')]),
  ...tail,
];

test('R1 第 N 轮收齐之前在别的提交上的登记不算最后一轮：收齐后在 B 登记代码 fail 才是最后一轮，只用收齐之后的记录算（0.10.1 代码 M5、一致性 M2）', () => {
  const s = rs(r1Entries());
  assert.equal(s.phase, 'collecting');
  assert.equal(s.finalHead, B);
  assert.equal(s.latest.head, B);
  assert.equal(s.latest.index, 3, '最后一轮是第 N+1 轮');
  assert.deepEqual(s.latest.missingKinds, ['consistency'], '收齐前 B 上的一致性审不算');
  assert.equal(s.latest.collected, false);
  assert.deepEqual(s.latest.counts, { high: 0, medium: 1 });
  assert.equal(s.latest.records.consistency, undefined, '最后一轮的记录里没有收齐前的那份一致性审');
  assert.equal(admitRegistration(s, { verdict: 'pass', kind: 'consistency', head: B, userDecision: null }), null, '最后一轮的一致性审放行');
  assert.equal(typeof admitRegistration(s, { verdict: 'pass', kind: 'code', head: B, userDecision: null }), 'string', '代码复审在最后一轮已登记过');
});

test('R2 R1 之后在 B 登记一致性审 pass：收齐、只剩中级是 close-only；最后一轮的一致性记录是收齐之后那条（0.10.1 代码 M5、一致性 M2）', () => {
  const s = rs(r1Entries([pass('consistency', B)]));
  assert.equal(s.phase, 'close-only');
  assert.equal(s.latest.head, B);
  assert.equal(s.latest.collected, true);
  assert.equal(s.latest.records.consistency.userDecision, null, '是收齐之后的那条，不是带用户决定的早先那条');
  assert.equal(s.finalHead, B);
});

test('R3 R1 之后在 B 补的是一致性审 defer：同样收齐，close-only（0.10.1 代码 M5、一致性 M2）', () => {
  const s = rs(r1Entries([rec('consistency', 'defer', B)]));
  assert.equal(s.phase, 'close-only');
  assert.equal(s.latest.collected, true);
  assert.equal(s.latest.records.consistency.verdict, 'defer');
});

test('R4 收齐之后最后一轮先登记代码 pass（B），收齐前 B 上有一致性审登记：final-next、finalHead B、finalKinds 只有 code，一致性审放行（0.10.1 代码 M5、一致性 M2）', () => {
  const s = rs([...roundHigh(C), fail('code', A, [f('H1'), f('M1')]), rec('consistency', 'pass', B, [], { userDecision: EARLY }), pass('consistency', A), pass('code', B)]);
  assert.equal(s.phase, 'final-next');
  assert.equal(s.finalHead, B);
  assert.deepEqual(s.finalKinds, ['code']);
  assert.equal(admitRegistration(s, { verdict: 'pass', kind: 'consistency', head: B, userDecision: null }), null);
});

test('R4 finalKinds 把 pass、fail、accept、defer 都算作最后一轮已有的种类（0.10.1 代码 M5）', () => {
  for (const [name, entry] of [['pass', pass('consistency', C)], ['fail', fail('consistency', C, [f('M1')])], ['accept', rec('consistency', 'accept', C, [], { userDecision: '用户接受' })], ['defer', rec('consistency', 'defer', C)]]) {
    const s = rs([...roundHigh(A), ...roundHigh(B), pass('code', C), entry]);
    assert.deepEqual([...s.finalKinds].sort(), ['code', 'consistency'], name);
  }
});

test('R4 第 N 轮之后、不是 finalHead 的提交上出现 fail（收齐后）：stop（本轮超出允许的最后一轮）（0.10.1 代码 M5）', () => {
  const s = rs([...roundHigh(A), ...roundHigh(B), pass('code', C), fail('code', D, [f('M1')]), pass('consistency', D)]);
  assert.equal(s.finalHead, C);
  assert.equal(s.phase, 'stop');
  assert.ok(s.reasons.length > 0);
});

test('R5 finalRoundTarget 表驱动：final-next 且 finalHead 未定时只有新提交算最后一轮；finalHead 已定时只有 finalHead 算；其余阶段都不算（0.10.1 代码 M5、一致性 M2）', () => {
  assert.equal(typeof RR.finalRoundTarget, 'function', 'review-rounds.mjs 应导出 finalRoundTarget');
  const cases = [
    ['final-next、finalHead 未定：新提交', finalNext(), E, true],
    ['final-next、finalHead 未定：latest.head（B）', finalNext(), B, false],
    ['final-next、finalHead 未定：更早的提交（A）', finalNext(), A, true],
    ['finalHead 已定（C）：C', finalNextSet(), C, true],
    ['finalHead 已定（C）：别的提交', finalNextSet(), E, false],
    ['finalHead 已定（C）：原失败提交', finalNextSet(), B, false],
    ['最后一轮已有 fail、collecting：finalHead（B）', rs(r1Entries()), B, true],
    ['最后一轮已有 fail、collecting：别的提交', rs(r1Entries()), A, false],
    ['最后一轮收齐、close-only：finalHead（B）', rs(r1Entries([pass('consistency', B)])), B, true],
    ['最后一轮收齐、close-only：别的提交', rs(r1Entries([pass('consistency', B)])), E, false],
    ['open', open(), E, false],
    ['open：latest.head', open(), A, false],
    ['off', rs(roundHigh(A), { closure: 'off' }), E, false],
    ['第 N 轮就是 close-only（finalHead 未定）', closeOnly(), E, false],
    ['第 N 轮就是 close-only：latest.head', closeOnly(), B, false],
    ['没有 latest（没有任何登记）', rs([], {}), E, false],
    ['只有 pass、没有 fail（latest 为 null）', rs([pass('code', A)]), E, false],
    ['未收齐的第 1 轮（collecting、finalHead 未定）', collecting(), E, false],
    ['stop 且 finalHead 已定：finalHead', stop(), C, true],
    ['stop 且 finalHead 已定：别的提交', stop(), E, false],
  ];
  for (const [name, state, head, expected] of cases) assert.equal(RR.finalRoundTarget(state, head), expected, name);
});

// ---------- 0.10.1：风险登记的核对（代码 H2） ----------

test('P4 closureProblems：findingSha、dataSha、severity、status 与预期不一致各自报出并点名 M1；摘要为空白、过长、含控制字符（含换行）、null 都报出（0.10.1 代码 H2）', () => {
  assert.deepEqual(closureProblems(goodFacts()), [], '对照：合格的新格式没有问题');
  for (const field of ['findingSha', 'dataSha']) assert.match(all(goodFacts(withEntry({ [field]: 'a'.repeat(64) }))), /M1/, field);
  assert.match(all(goodFacts(withEntry({ severity: 'high' }))), /M1/);
  assert.match(all(goodFacts(withEntry({ status: '已修' }))), /M1/);
  const badSummaries = { 空白: '   ', 空串: '', 过长: 'x'.repeat(301), 换行: `第一行${NL}第二行`, 制表符: '有\t制表符', 空: null };
  for (const [name, summary] of Object.entries(badSummaries)) assert.match(all(goodFacts(withEntry({ summary }))), /M1/, `摘要${name}`);
  assert.deepEqual(closureProblems(goodFacts(withEntry({ summary: 'x'.repeat(300) }))), [], '恰好 300 字符合格');
  assert.deepEqual(closureProblems(goodFacts(withEntry({ summary: '  前后有空白的摘要  ' }))), [], '去掉首尾空白后非空即可');
});

test('P6 closureProblems：同一身份只有旧格式条目时报“旧格式”；同身份已有新格式条目时旧行不碍事（0.10.1 代码 H2）', () => {
  const g = goodFacts();
  const legacy = { ...legacyEntry({ commit: g.expected[0].commit, round: g.expected[0].round }), legacy: true };
  assert.match(closureProblems({ ...g, register: { entries: [legacy], problems: [] } }).join('|'), /旧格式/);
  assert.deepEqual(closureProblems({ ...g, register: { entries: [legacy, ...g.register.entries], problems: [] } }), []);
});

// ---------- 0.10.1：收口的修复差异白名单（代码 H1） ----------

test('W6 closureProblems：修复差异含白名单外的文件时报出该文件并写明“白名单”和出路；exempt 为真的文件、定位文件、fixedIn、风险登记不报；缺省 exempt 视为都不豁免（0.10.1 代码 H1）', () => {
  const g = goodFacts();
  const out = (over) => closureProblems({ ...g, ...over }).join('|');
  const bad = out({ fixDiff: ['src/dedup.ts', 'src/f9.ts'] });
  assert.ok(bad.includes('src/f9.ts'), bad);
  assert.match(bad, /白名单/);
  assert.match(bad, /--user-decision/, '写明出路之一：由用户决定后做普通双审');
  assert.deepEqual(closureProblems({ ...g, fixDiff: ['src/dedup.ts', 'test/dedup.test.ts', 'docs/note.md'], exempt: (file) => file.startsWith('test/') || file.startsWith('docs/') }), [], 'exempt 为真的不报');
  const partial = out({ fixDiff: ['src/dedup.ts', 'test/dedup.test.ts', 'src/f9.ts'], exempt: (file) => file.startsWith('test/') });
  assert.ok(partial.includes('src/f9.ts') && !partial.includes('test/dedup.test.ts'), partial);
  assert.match(out({ fixDiff: ['src/dedup.ts', 'test/dedup.test.ts'] }), /test\/dedup\.test\.ts/, '没给 exempt：测试文件也不豁免');
  assert.deepEqual(closureProblems({ ...g, fixDiff: ['src/dedup.ts', 'docs/04-开发/review-risks.jsonl'] }), [], '风险登记文件本身允许（registerPath）');
  const declared = goodFacts({ fixDiff: ['src/other.ts'] });
  declared.register = { entries: [{ ...declared.expected[0], summary: SUMMARY, fixedIn: ['src/other.ts'] }], problems: [] };
  assert.deepEqual(closureProblems(declared), [], '--fixed-in 申报的路径允许');
});
