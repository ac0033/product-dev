// 轮次收口纯函数测试：roundState、admitRegistration、nextHint、expectedRiskEntries、parseRiskRegister、closureProblems（A6–A14、A10b、“已修”证据）。
// 表驱动：不碰 fs、git、gh；entries 就是 PR 的 log.jsonl 行。文案只按关键词匹配，不绑定整句。
import assert from 'node:assert/strict';
import { test } from 'node:test';
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

test('A10b admitRegistration：accept、defer、有内容的 userDecision 在任何阶段恒放行', () => {
  for (const [name, state] of [['collecting', collecting()], ['close-only', closeOnly()], ['final-next', finalNext()], ['stop', stop()]]) {
    assert.equal(admit(state, { verdict: 'accept' }), null, `${name} accept`);
    assert.equal(admit(state, { verdict: 'defer', kind: 'consistency' }), null, `${name} defer`);
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

test('A12 expectedRiskEntries：只取 medium，文本逐字取自发现，fixedIn 为空数组，两种审查同号各一条', () => {
  const failures = [
    { kind: 'code', findings: [full('H1'), full('M1'), full('L1'), full('I1')] },
    { kind: 'consistency', findings: [full('M1'), full('M2')] },
  ];
  const entries = expectedRiskEntries({ pr: '7', round: 2, failHead: B, failures });
  assert.deepEqual(entries, [
    { pr: '7', commit: B, round: 2, kind: 'code', id: 'M1', severity: 'medium', location: 'src/dedup.ts:M1', problem: '问题 M1', reason: '理由 M1', fix: '改法 M1', status: STATUS, fixedIn: [] },
    { pr: '7', commit: B, round: 2, kind: 'consistency', id: 'M1', severity: 'medium', location: 'src/dedup.ts:M1', problem: '问题 M1', reason: '理由 M1', fix: '改法 M1', status: STATUS, fixedIn: [] },
    { pr: '7', commit: B, round: 2, kind: 'consistency', id: 'M2', severity: 'medium', location: 'src/dedup.ts:M2', problem: '问题 M2', reason: '理由 M2', fix: '改法 M2', status: STATUS, fixedIn: [] },
  ]);
  assert.deepEqual(expectedRiskEntries({ pr: '7', round: 1, failHead: A, failures: [{ kind: 'code', findings: [full('H1'), full('L1')] }] }), []);
});

test('A12 parseRiskRegister：合格的行解析成条目，空行跳过', () => {
  const e = expectedRiskEntries({ pr: '7', round: 2, failHead: B, failures: [{ kind: 'code', findings: [full('M1')] }] })[0];
  const r = parseRiskRegister([JSON.stringify(e), '', JSON.stringify({ ...e, id: 'M2' }), ''].join(NL));
  assert.deepEqual(r.problems, []);
  assert.equal(r.entries.length, 2);
  assert.deepEqual(r.entries[0], e);
});

test('A12 parseRiskRegister：坏行按行号报（不是 JSON、不是对象、缺键、多键、类型不对）', () => {
  const e = expectedRiskEntries({ pr: '7', round: 2, failHead: B, failures: [{ kind: 'code', findings: [full('M1')] }] })[0];
  const { fixedIn, ...missing } = e;
  const bads = {
    '坏 JSON': '{ 坏的',
    数组: '[]',
    数字: '5',
    缺键: JSON.stringify(missing),
    多键: JSON.stringify({ ...e, extra: 1 }),
    'fixedIn 不是数组': JSON.stringify({ ...e, fixedIn: 'src/a.ts' }),
    'round 不是数字': JSON.stringify({ ...e, round: '2' }),
  };
  for (const [name, line] of Object.entries(bads)) {
    const r = parseRiskRegister([JSON.stringify(e), '', line].join(NL));
    assert.equal(r.problems.length, 1, `${name}：${JSON.stringify(r.problems)}`);
    assert.match(r.problems[0], /3/, `${name}：按行号报（第 3 行）`);
  }
});

// ---------- closureProblems ----------

const FAIL_FINDING = full('M1');
/** 满足全部前提的事实：第 N 轮（B）只剩中级，修复提交改了定位文件，风险登记完整。 */
function goodFacts(over = {}) {
  const state = closeOnly();
  const expected = expectedRiskEntries({ pr: '7', round: 2, failHead: B, failures: [{ kind: 'code', findings: [FAIL_FINDING] }] });
  return {
    closure: CLOSURE,
    flow: 'pr',
    prOpen: true,
    ciProblems: [],
    state,
    head: E,
    failHead: B,
    headIsDescendant: true,
    register: { entries: expected.map((x) => ({ ...x })), problems: [] },
    expected,
    fixDiff: ['src/dedup.ts'],
    registerPath: 'docs/04-开发/review-risks.jsonl',
    ...over,
  };
}
const all = (facts) => closureProblems(facts).join('|');
const withEntry = (over) => {
  const g = goodFacts();
  return { register: { entries: [{ ...g.expected[0], ...over }], problems: [] } };
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
  assert.match(all(goodFacts({ register: { entries: g.expected, problems: ['第 2 行：不是合法条目'] } })), /第 2 行/);
  assert.match(all(goodFacts({ register: { entries: [], problems: [] } })), /M1/);
  assert.match(all(goodFacts(withEntry({ id: 'M9' }))), /M1/, '只有别的编号的条目等于条目缺失');
  assert.ok(all(goodFacts(withEntry({ pr: '8' }))).length > 0, '身份（pr）不同视为缺失');
  assert.ok(all(goodFacts(withEntry({ commit: A }))).length > 0, '身份（commit）不同');
  assert.ok(all(goodFacts(withEntry({ round: 1 }))).length > 0, '身份（round）不同');
  assert.ok(all(goodFacts(withEntry({ kind: 'consistency' }))).length > 0, '身份（kind）不同');
});

test('A12 closureProblems：文本只差一个字符、状态不对都报出，并点名编号', () => {
  for (const field of ['severity', 'location', 'problem', 'reason', 'fix']) {
    const g = goodFacts();
    const changed = field === 'severity' ? 'high' : `${g.expected[0][field]}。`;
    assert.match(all(goodFacts(withEntry({ [field]: changed }))), /M1/, field);
  }
  assert.match(all(goodFacts(withEntry({ problem: '间题 M1' }))), /M1/, '只差一个字');
  assert.match(all(goodFacts(withEntry({ status: '已修' }))), /M1/, '状态不对');
});

test('A12 closureProblems：同一身份出现两条报出', () => {
  const g = goodFacts();
  assert.match(all(goodFacts({ register: { entries: [g.expected[0], { ...g.expected[0] }], problems: [] } })), /M1/);
});

test('A12 closureProblems：登记文件里期望之外的条目不影响', () => {
  const g = goodFacts();
  const extra = { ...g.expected[0], id: 'M7', commit: A, round: 1 };
  assert.deepEqual(closureProblems(goodFacts({ register: { entries: [extra, g.expected[0]], problems: [] } })), []);
});

test('A12 “已修”证据：发现有 files 且命中修复差异时成立，不要求 fixedIn', () => {
  assert.deepEqual(closureProblems(goodFacts({ fixDiff: ['src/dedup.ts', 'src/other.ts'] })), []);
  const expected = expectedRiskEntries({ pr: '7', round: 2, failHead: B, failures: [{ kind: 'code', findings: [{ ...FAIL_FINDING, files: ['src/x.ts', 'src/dedup.ts'] }] }] });
  assert.deepEqual(closureProblems(goodFacts({ expected, register: { entries: expected.map((x) => ({ ...x })), problems: [] } })), [], '至少一个命中即可');
});

test('A12 “已修”证据：有 files 未命中但 fixedIn 非空且都在修复差异里时成立', () => {
  const g = goodFacts({ fixDiff: ['src/other.ts', 'src/more.ts'] });
  g.register = { entries: [{ ...g.expected[0], fixedIn: ['src/other.ts', 'src/more.ts'] }], problems: [] };
  assert.deepEqual(closureProblems(g), []);
});

test('A12 “已修”证据：有 files 都不命中，且 fixedIn 为空、不在差异里或只有一部分在，都报“都不在修复差异里”', () => {
  for (const [name, fixedIn] of [['fixedIn 为空', []], ['fixedIn 不在差异里', ['src/elsewhere.ts']], ['fixedIn 只有一部分在差异里', ['src/other.ts', 'src/elsewhere.ts']]]) {
    const g = goodFacts({ fixDiff: ['src/other.ts'] });
    g.register = { entries: [{ ...g.expected[0], fixedIn }], problems: [] };
    const out = closureProblems(g).join('|');
    assert.match(out, /M1/, name);
    assert.ok(out.includes('src/dedup.ts'), `${name}：写明定位文件`);
    assert.match(out, /修复差异/, name);
  }
  assert.match(closureProblems(goodFacts({ fixDiff: [] })).join('|'), /修复差异/, '修复差异为空');
});

test('A12 “已修”证据：发现没有 files 时 fixedIn 必须非空且都在修复差异里', () => {
  const noFiles = { ...FAIL_FINDING, files: [] };
  const expected = expectedRiskEntries({ pr: '7', round: 2, failHead: B, failures: [{ kind: 'code', findings: [noFiles] }] });
  const mk = (fixedIn, fixDiff) => goodFacts({ expected, fixDiff, register: { entries: [{ ...expected[0], fixedIn }], problems: [] } });
  assert.match(closureProblems(mk([], ['src/dedup.ts'])).join('|'), /修复差异/, 'fixedIn 为空');
  assert.match(closureProblems(mk(['src/elsewhere.ts'], ['src/dedup.ts'])).join('|'), /修复差异/, 'fixedIn 不在差异里');
  assert.match(closureProblems(mk(['src/dedup.ts', 'src/elsewhere.ts'], ['src/dedup.ts'])).join('|'), /修复差异/, '只有一部分在差异里');
  assert.deepEqual(closureProblems(mk(['src/dedup.ts'], ['src/dedup.ts'])), []);
  const noKey = { ...FAIL_FINDING };
  delete noKey.files;
  const expectedNoKey = expectedRiskEntries({ pr: '7', round: 2, failHead: B, failures: [{ kind: 'code', findings: [noKey] }] });
  assert.match(closureProblems(goodFacts({ expected: expectedNoKey, register: { entries: expectedNoKey.map((x) => ({ ...x })), problems: [] } })).join('|'), /修复差异/, '没有 files 键同样处理');
});

