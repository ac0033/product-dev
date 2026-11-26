// 轮次与收口判定测试（gate/rounds.mjs，纯函数）：按计划“轮次口径”表逐行写 roundState / roundBlock，N=2 与 N=3 各一组，
// 另测收口关闭时与旧行为一致、并行第二份登记的例外、--user-decision 放行、收敛提示 trendWarnings。
// 对应契约 A6–A9、A11、A10 的机械部分。
// 约定的接口（计划只定了函数名与大致参数，下面的形状是测试的假定，见交回说明）：
//   条目 entry = { kind, verdict, headSha, findings }；findings 为登记记录里的 { parsed, high, medium, low, info, unresolvable, highIds, mediumIds }，解析不出为 null。
//   roundState(entries, { keyOf, limit, closure }) → { phase, counted }；phase 取 open | final-next | close-only | stop；closure 取 'off' | 'fix-and-record'。
//   roundBlock(prior, verdict, ctx) → 拒绝文案或 null；ctx = { limit, userDecision, scope, cur: { key, kind }, keyOf, closure }。
//   trendWarnings(entries, keyOf) → 字符串数组（没有情形时为空数组）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failKeys, ROUND_KEYS, roundBlock, roundState, trendWarnings } from '../gate/rounds.mjs';
import * as review from '../gate/review.mjs';

const keyOf = ROUND_KEYS.pr.of;
const CLOSURE = 'fix-and-record';
const sha = (c) => c.repeat(40);

/** 发现统计：high、medium 各几条，可附 unresolvable 与编号。 */
const F = (high, medium = 0, extra = {}) => ({
  parsed: high + medium + (extra.low ?? 0), high, medium, low: 0, info: 0, unresolvable: 0,
  highIds: Array.from({ length: high }, (_, i) => `H${i + 1}`),
  mediumIds: Array.from({ length: medium }, (_, i) => `M${i + 1}`),
  ...extra,
});
const fail = (head, findings, kind = 'code') => ({ kind, verdict: 'fail', headSha: sha(head), findings });
const pass = (head, kind = 'code') => ({ kind, verdict: 'pass', headSha: sha(head), findings: F(0) });

const ctx = (over = {}) => ({ limit: 2, userDecision: undefined, scope: '这个 PR ', cur: { key: sha('z'), kind: 'code' }, keyOf, closure: CLOSURE, ...over });
const state = (entries, over = {}) => roundState(entries, { keyOf, limit: 2, closure: CLOSURE, ...over });
const block = (entries, verdict = 'pass', over = {}) => roundBlock(entries, verdict, ctx(over));

test('迁移不回归：ROUND_KEYS 与 review.mjs 的导出一致，failKeys 只数 fail 的不同内容', () => {
  assert.equal(review.ROUND_KEYS, ROUND_KEYS);
  assert.equal(ROUND_KEYS.pr.unit, '按提交计');
  assert.deepEqual(failKeys([fail('a', F(1)), fail('a', F(0, 1), 'consistency'), pass('b'), fail('c', F(0, 1))], keyOf), [sha('a'), sha('c')]);
});

// ---------- 轮次口径表（N=2） ----------

test('A6 口径表 N=2：已计入的 fail 轮数 < N 为 open，新内容上 pass、fail 都放行', () => {
  assert.equal(state([]).phase, 'open');
  const one = [fail('a', F(1, 1))];
  assert.equal(state(one).phase, 'open');
  assert.equal(state(one).counted, 1);
  for (const v of ['pass', 'fail']) assert.equal(block(one, v), null, v);
});

test('A7 口径表 N=2：第 N 轮有高级（发现表可解析）为 final-next，新内容上放行且不要 --user-decision', () => {
  const two = [fail('a', F(1)), fail('b', F(1, 1))];
  assert.equal(state(two).phase, 'final-next');
  assert.equal(state(two).counted, 2);
  for (const v of ['pass', 'fail']) assert.equal(block(two, v), null, v);
  // 最新一轮里任一份 fail 有高级就算：代码复审只有中级、一致性审有高级
  const split = [fail('a', F(0, 1)), fail('b', F(0, 1)), fail('b', F(1), 'consistency')];
  assert.equal(state(split).phase, 'final-next');
});

test('A6 口径表 N=2：第 N 轮无高级、无“无法彻底解决”、可解析为 close-only，新内容上 pass、fail 都被拒并指向 close', () => {
  const two = [fail('a', F(1)), fail('b', F(0, 2))];
  assert.equal(state(two).phase, 'close-only');
  for (const v of ['pass', 'fail']) {
    const msg = block(two, v);
    assert.match(msg ?? '', /review\.mjs close/, v);
  }
  // 低级与提示不影响
  assert.equal(state([fail('a', F(0, 1)), fail('b', { ...F(0, 0), parsed: 2, low: 1, info: 1 })]).phase, 'close-only');
});

test('A8 口径表 N=2：第 N 轮有“无法彻底解决”，或发现表不可解析，为 stop：要 --user-decision，文案写明向用户汇报与专项', () => {
  const unresolvable = [fail('a', F(1)), fail('b', F(0, 1, { unresolvable: 1 }))];
  const unparsed = [fail('a', F(1)), fail('b', null)];
  for (const entries of [unresolvable, unparsed]) {
    assert.equal(state(entries).phase, 'stop');
    const msg = block(entries, 'pass');
    assert.match(msg ?? '', /--user-decision/);
    assert.match(msg ?? '', /向用户汇报/);
    assert.match(msg ?? '', /专项/);
  }
});

test('A7/A8/A9 口径表 N=2：第 N+1 轮经 final-next 进入时，有高级、有“无法彻底解决”或不可解析为 stop，只剩中、低级为 close-only', () => {
  const via = [fail('a', F(1)), fail('b', F(1))]; // 第 2 轮有高级，第 3 轮由此进入
  assert.equal(state([...via, fail('c', F(1, 1))]).phase, 'stop');
  assert.equal(state([...via, fail('c', F(0, 1, { unresolvable: 1 }))]).phase, 'stop');
  assert.equal(state([...via, fail('c', null)]).phase, 'stop');
  const onlyMedium = [...via, fail('c', F(0, 2))];
  assert.equal(state(onlyMedium).phase, 'close-only');
  assert.equal(state(onlyMedium).counted, 3);
  assert.match(block(onlyMedium, 'pass') ?? '', /review\.mjs close/);
  const msg = block([...via, fail('c', F(1))], 'fail');
  assert.match(msg ?? '', /向用户汇报/);
  assert.match(msg ?? '', /专项/);
});

test('A8 口径表 N=2：第 N+1 轮不是经 final-next 进入的（第 N 轮无高级、靠 --user-decision 再审了一轮），之后一律 stop，哪怕只剩中级', () => {
  const entries = [fail('a', F(1)), fail('b', F(0, 1)), fail('c', F(0, 1))];
  assert.equal(state(entries).phase, 'stop');
  assert.match(block(entries, 'pass') ?? '', /--user-decision/);
});

test('A8 口径表 N=2：已计入轮数超过 N+1 为 stop', () => {
  const entries = [fail('a', F(1)), fail('b', F(1)), fail('c', F(0, 1)), fail('d', F(0, 1))];
  assert.equal(state(entries).phase, 'stop');
  assert.match(block(entries, 'fail') ?? '', /--user-decision/);
});

// ---------- N=3 ----------

test('A7/A9 口径表 N=3：前两轮 open；第 3 轮有高级为 final-next；第 4 轮只剩中级为 close-only', () => {
  const lim = { limit: 3 };
  const two = [fail('a', F(1)), fail('b', F(1))];
  assert.equal(state(two, lim).phase, 'open');
  assert.equal(roundBlock(two, 'pass', ctx(lim)), null);
  const three = [...two, fail('c', F(1, 1))];
  assert.equal(state(three, lim).phase, 'final-next');
  assert.equal(roundBlock(three, 'pass', ctx(lim)), null, 'final-next 不要 --user-decision');
  const four = [...three, fail('d', F(0, 1))];
  assert.equal(state(four, lim).phase, 'close-only');
  assert.match(roundBlock(four, 'pass', ctx(lim)) ?? '', /review\.mjs close/);
});

test('A6/A8 口径表 N=3：第 3 轮无高级为 close-only；第 3 轮“无法彻底解决”为 stop；第 4 轮有高级为 stop', () => {
  const lim = { limit: 3 };
  const closeOnly = [fail('a', F(1)), fail('b', F(1)), fail('c', F(0, 1))];
  assert.equal(state(closeOnly, lim).phase, 'close-only');
  const stopUnres = [fail('a', F(1)), fail('b', F(1)), fail('c', F(0, 1, { unresolvable: 1 }))];
  assert.equal(state(stopUnres, lim).phase, 'stop');
  const stopHigh = [fail('a', F(1)), fail('b', F(1)), fail('c', F(1)), fail('d', F(1))];
  assert.equal(state(stopHigh, lim).phase, 'stop');
  assert.match(roundBlock(stopHigh, 'pass', ctx(lim)) ?? '', /专项/);
});

// ---------- 例外与放行 ----------

test('A6 并行双审的例外：已计入的最新一轮内容上，另一种 kind 首次登记照常放行；同一 kind 再登记仍被拒', () => {
  const entries = [fail('a', F(1)), fail('b', F(0, 1))]; // close-only，最新一轮是 b，只登记过 code
  const second = block(entries, 'fail', { cur: { key: sha('b'), kind: 'consistency' } });
  assert.equal(second, null, '并行第二份登记放行');
  assert.equal(block(entries, 'pass', { cur: { key: sha('b'), kind: 'consistency' } }), null);
  assert.match(block(entries, 'pass', { cur: { key: sha('b'), kind: 'code' } }) ?? '', /review\.mjs close/, '同一 kind 在同一内容上再登记被拒');
  // stop 阶段同样
  const stop = [fail('a', F(1)), fail('b', F(1)), fail('c', F(1))];
  assert.equal(block(stop, 'fail', { cur: { key: sha('c'), kind: 'consistency' } }), null);
  assert.ok(block(stop, 'fail', { cur: { key: sha('c'), kind: 'code' } }));
});

test('A8 --user-decision 在任何阶段都放行（close-only 与 stop）', () => {
  const closeOnly = [fail('a', F(1)), fail('b', F(0, 1))];
  const stop = [fail('a', F(1)), fail('b', F(1)), fail('c', F(1))];
  for (const entries of [closeOnly, stop]) {
    for (const v of ['pass', 'fail']) assert.equal(block(entries, v, { userDecision: '用户同意再审一轮（对话 2026-11-26）' }), null, v);
    assert.ok(block(entries, 'pass', { userDecision: '   ' }), '空白的决定不算');
  }
});

test('A6 不受拦截的登记：accept、defer、close 不走轮次拦截', () => {
  const entries = [fail('a', F(1)), fail('b', F(0, 1))];
  for (const v of ['accept', 'defer', 'close']) assert.equal(block(entries, v), null, v);
  // close 记录本身不计入轮次
  const withClose = [...entries, { kind: 'close', verdict: 'close', headSha: sha('c'), findings: null }];
  assert.equal(state(withClose).counted, 2);
});

// ---------- 收口关闭 ----------

test('A11 收口关闭：与旧行为一致——满上限后 pass、fail 要 --user-decision，文案是原来的“已审二轮仍需再审”，不提 close 与最后一轮', () => {
  const entries = [fail('a', F(1)), fail('b', F(0, 1))];
  for (const closure of ['off', undefined]) {
    const msg = block(entries, 'pass', { closure });
    assert.match(msg ?? '', /已审二轮仍需再审/);
    assert.match(msg ?? '', /--user-decision/);
    assert.doesNotMatch(msg ?? '', /review\.mjs close|最后一轮/);
    assert.equal(block(entries, 'pass', { closure, userDecision: '用户同意（对话）' }), null);
    // 并行第二份登记的旧例外照旧
    assert.equal(block(entries, 'pass', { closure, cur: { key: sha('b'), kind: 'consistency' } }), null);
    assert.ok(block(entries, 'pass', { closure, cur: { key: sha('b'), kind: 'code' } }));
  }
  assert.equal(block([fail('a', F(1))], 'pass', { closure: 'off' }), null, '上限未满放行');
});

// ---------- 收敛提示 ----------

test('A10 收敛提示：最新两轮之间同一编号再次出现、级别升高、数量增加，各有一条提示；没有这些情形时为空', () => {
  const round = (head, findings) => fail(head, findings);
  // 没有情形：数量减少，编号不同
  assert.deepEqual(trendWarnings([round('a', F(0, 3)), round('b', { ...F(0, 1), mediumIds: ['M9'] })], keyOf), []);
  assert.deepEqual(trendWarnings([round('a', F(0, 3))], keyOf), [], '只有一轮没有可比较的');
  assert.deepEqual(trendWarnings([], keyOf), []);
  // 级别升高：上一轮只有中级，这一轮出现高级（高+中总数不变、编号不同）
  const up = trendWarnings([
    round('a', { ...F(0, 2), mediumIds: ['M1', 'M2'] }),
    round('b', { ...F(1, 1), highIds: ['H3'], mediumIds: ['M4'] }),
  ], keyOf);
  assert.equal(up.length, 1, JSON.stringify(up));
  // 数量增加：高+中由 1 条变 3 条（编号不同、没有高级）
  const more = trendWarnings([
    round('a', { ...F(0, 1), mediumIds: ['M1'] }),
    round('b', { ...F(0, 3), mediumIds: ['M2', 'M3', 'M4'] }),
  ], keyOf);
  assert.equal(more.length, 1, JSON.stringify(more));
  // 同类反复出现：同一编号在连续两轮都出现，数量不变、级别不变
  const again = trendWarnings([
    round('a', { ...F(0, 1), mediumIds: ['M1'] }),
    round('b', { ...F(0, 1), mediumIds: ['M1'] }),
  ], keyOf);
  assert.equal(again.length, 1, JSON.stringify(again));
  for (const w of [...up, ...more, ...again]) assert.equal(typeof w, 'string');
});
