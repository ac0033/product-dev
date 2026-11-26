// 轮次判定测试（gate/rounds.mjs，纯函数）：迁移出来的 ROUND_KEYS、failKeys、roundBlock 与原来在 review.mjs 里的行为一致。
// 业务含义：满 maxReviewRounds 份不同内容登记过不通过后，再登记 pass、fail 要用户决定；并行双审的第二份登记不被它自己这一轮拦住；
// accept、defer 不计轮次、不受拦截。轮次收口（close、最后一轮）另做，不在这里。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failKeys, ROUND_KEYS, roundBlock } from '../gate/rounds.mjs';
import * as review from '../gate/review.mjs';

const keyOf = ROUND_KEYS.pr.of;
const sha = (c) => c.repeat(40);
const fail = (head, kind = 'code') => ({ kind, verdict: 'fail', headSha: sha(head) });
const pass = (head, kind = 'code') => ({ kind, verdict: 'pass', headSha: sha(head) });

const ctx = (over = {}) => ({ limit: 2, userDecision: undefined, scope: '这个 PR ', cur: { key: sha('z'), kind: 'code' }, keyOf, ...over });
const block = (entries, verdict = 'pass', over = {}) => roundBlock(entries, verdict, ctx(over));

test('迁移不回归：ROUND_KEYS 与 review.mjs 的导出一致，failKeys 只数 fail 的不同内容', () => {
  assert.equal(review.ROUND_KEYS, ROUND_KEYS);
  assert.equal(ROUND_KEYS.pr.unit, '按提交计');
  assert.deepEqual(failKeys([fail('a'), fail('a', 'consistency'), pass('b'), fail('c')], keyOf), [sha('a'), sha('c')]);
});

test('满上限：新内容上 pass、fail 要 --user-decision，文案是“已审二轮仍需再审”；上限未满放行', () => {
  const entries = [fail('a'), fail('b')];
  for (const v of ['pass', 'fail']) {
    const msg = block(entries, v);
    assert.match(msg ?? '', /已审二轮仍需再审/, v);
    assert.match(msg ?? '', /--user-decision/, v);
  }
  assert.equal(block(entries, 'pass', { userDecision: '用户同意（对话）' }), null);
  assert.ok(block(entries, 'pass', { userDecision: '   ' }), '空白的决定不算');
  assert.equal(block([fail('a')], 'pass'), null, '上限未满放行');
});

test('并行双审的例外：已计入的内容上另一种审查首次登记照常放行；同一种审查再登记仍被拒', () => {
  const entries = [fail('a'), fail('b')];
  assert.equal(block(entries, 'fail', { cur: { key: sha('b'), kind: 'consistency' } }), null);
  assert.equal(block(entries, 'pass', { cur: { key: sha('b'), kind: 'consistency' } }), null);
  assert.ok(block(entries, 'pass', { cur: { key: sha('b'), kind: 'code' } }));
});

test('accept、defer 不计轮次、不受拦截', () => {
  const entries = [fail('a'), fail('b')];
  for (const v of ['accept', 'defer']) assert.equal(block(entries, v), null, v);
});
