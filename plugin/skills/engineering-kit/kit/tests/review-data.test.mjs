// 复审数据（ek-review/1）纯函数测试：hasContent、validateReviewData、verdictOf、fingerprint、coverageOf、admissionProblems、renderReport。
// 对应契约 contract-structured.md 的 S2、S3、S4、S5、S6、S7、S8、H3、H7；全部表驱动，不碰 fs、git、gh。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  admissionProblems,
  compactFindings,
  coverageOf,
  fingerprint,
  hasContent,
  renderReport,
  validateReviewData,
  verdictOf,
} from '../gate/review-data.mjs';
import { failingData, finding, reviewData } from './helpers.mjs';

const BS = String.fromCharCode(92); // 反斜杠
const ZW = String.fromCodePoint(0x200b); // 零宽空格
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const M = 'c'.repeat(40);
const SECTIONS = ['范围', '发现', '作者的验证']; // 与 config.reviewSections 默认值同形：含“发现”，校验时只要求其余各节

/** 校验并返回问题列表。 */
const problemsOf = (data, flow = 'pre-push') => validateReviewData(data, { sections: SECTIONS, flow });
/** 问题列表里是否有一条同时含全部关键词。 */
const has = (problems, ...words) => problems.some((p) => words.every((w) => p.includes(w)));
/** 合格的测试缺口检查（三项都已核实）。 */
const gaps = (over = {}) => ({
  functions: { status: 'verified', note: '每个功能点都有对应测试。' },
  layers: { status: 'verified', note: '单元与集成层都有。' },
  boundaries: { status: 'verified', note: '空数组和重复项都覆盖。' },
  ...over,
});
/** 高风险的合格通过数据。 */
const highPass = (over = {}) => reviewData({ risk: 'high', testGaps: gaps(), ...over });
/** pr 流程的合格数据。 */
const prData = (over = {}) => reviewData({ reviewedCommit: A, reviewedBase: M, ...over });

test('S2 hasContent：占位词、HTML 实体、零宽字符、只有标点都算没有内容', () => {
  const empty = ['', '   ', '\n\t', '无', '暂无', '待补', '待定', '-', '—', '/', 'n/a', 'N/A', 'na', 'TBD', 'tbd', 'todo', 'None', ' 无 ', '&nbsp;', '&#160;', '&#xA0;', '&#xa0;', ZW, `${ZW}${ZW}`, '。。。', '...', '---', '，；', '&nbsp;&#160; ', `${ZW}&nbsp;${ZW}`];
  for (const s of empty) assert.equal(hasContent(s), false, JSON.stringify(s));
  const full = ['空数组时返回 undefined。', 'abc', '0', '无法复现', '没有无', 'a', '&nbsp;x', 'a&b', '第 1 条', 'Z', '修改 src/a.ts'];
  for (const s of full) assert.equal(hasContent(s), true, JSON.stringify(s));
  for (const nonString of [null, undefined, 3, {}, []]) assert.equal(hasContent(nonString), false);
});

test('S2 validateReviewData：合格数据返回空数组（含 pr 流程、高风险、带处置与 files）', () => {
  assert.deepEqual(problemsOf(reviewData()), []);
  assert.deepEqual(problemsOf(failingData()), []);
  assert.deepEqual(problemsOf(prData(), 'pr'), []);
  assert.deepEqual(problemsOf(highPass()), []);
  const rich = failingData({
    findings: [finding({ files: ['src/dedup.ts'], unresolvable: false, systemic: false, tag: '既有', prior: null }), finding({ id: 'L1', severity: 'low', location: '', trigger: '', reason: '', fix: '' })],
    dispositions: [{ id: 'H1', status: 'fixed', evidence: 'diff 里已改。' }],
  });
  assert.deepEqual(problemsOf(rich), []);
  assert.deepEqual(problemsOf(reviewData({ sections: { 范围: '读了。', 作者的验证: '核对了。', 额外: '多出的节也要有内容。' } })), []);
});

test('S2 缺字段：每个必需的顶层字段缺失都被指出字段名', () => {
  for (const key of ['format', 'kind', 'verdict', 'risk', 'sections', 'findings']) {
    const data = reviewData();
    delete data[key];
    const p = problemsOf(data);
    assert.ok(has(p, key), `缺 ${key}：${p.join(' / ')}`);
  }
});

test('S2 多出未定义的顶层字段、类型或枚举不对：拒绝并指出字段', () => {
  assert.ok(has(problemsOf(reviewData({ extra: 1 })), 'extra'));
  const cases = [
    [{ format: 'ek-review/2' }, 'format'],
    [{ kind: 'tests' }, 'kind'],
    [{ verdict: 'maybe' }, 'verdict'],
    [{ risk: 'medium' }, 'risk'],
    [{ findings: 'x' }, 'findings'],
    [{ sections: '范围' }, 'sections'],
    [{ dispositions: 'x' }, 'dispositions'],
  ];
  for (const [over, word] of cases) assert.ok(has(problemsOf(reviewData(over)), word), JSON.stringify(over));
  assert.ok(problemsOf(null).length > 0);
  assert.ok(problemsOf([]).length > 0);
  assert.ok(problemsOf('x').length > 0);
});

test('S2 发现字段：枚举错、缺字段、类型错、多出字段都指出第几条发现与字段', () => {
  const bad = (f, word) => {
    const p = problemsOf(failingData({ findings: [finding(), f] }));
    assert.ok(has(p, '第 2 条发现', word), `${word}：${p.join(' / ')}`);
  };
  bad(finding({ id: 'M2', severity: 'critical' }), 'severity');
  bad(finding({ id: 'M2', problem: 5 }), 'problem');
  bad(finding({ id: 'M2', tag: '随便' }), 'tag');
  bad(finding({ id: 'M2', unresolvable: 'yes' }), 'unresolvable');
  bad(finding({ id: 'M2', systemic: 1 }), 'systemic');
  bad(finding({ id: 'M2', prior: 'X' }), 'prior');
  bad(finding({ id: 'M2', surprise: 1 }), 'surprise');
  const noReason = finding({ id: 'M2' });
  delete noReason.reason;
  bad(noReason, 'reason');
  const noId = finding();
  delete noId.id;
  bad(noId, 'id');
  assert.ok(has(problemsOf(failingData({ findings: ['x'] })), '第 1 条发现'));
  assert.deepEqual(problemsOf(failingData({ findings: [finding({ tag: null, prior: null })] })), []);
});

test('S2 编号：重复、前缀与级别不符、格式不对都拒绝并指出编号', () => {
  const dup = problemsOf(failingData({ findings: [finding(), finding()] }));
  assert.ok(has(dup, 'M1', '重复') || has(dup, 'M1', '唯一'), dup.join(' / '));
  const mismatch = [
    finding({ id: 'M1', severity: 'high' }),
    finding({ id: 'H1', severity: 'medium' }),
    finding({ id: 'M1', severity: 'low' }),
    finding({ id: 'L1', severity: 'info' }),
    finding({ id: 'M0' }),
    finding({ id: 'M01' }),
    finding({ id: 'X1' }),
    finding({ id: 'M' }),
  ];
  for (const f of mismatch) {
    const p = problemsOf(failingData({ findings: [f] }));
    assert.ok(has(p, '第 1 条发现', 'id'), `${f.id}/${f.severity}：${p.join(' / ')}`);
  }
  assert.deepEqual(problemsOf(failingData({ findings: [finding({ id: 'H1', severity: 'high' }), finding({ id: 'M2' }), finding({ id: 'L3', severity: 'low' }), finding({ id: 'I4', severity: 'info' })] })), []);
});

test('S2 文本：单行字段含换行、控制字符、零宽字符、行分隔符都拒绝', () => {
  const single = [
    [{ location: 'a\nb' }, 'location'],
    [{ id: 'M1\n' }, 'id'],
    [{ files: ['a\nb.ts'] }, 'files'],
    [{ prior: 'M1\n' }, 'prior'],
  ];
  for (const [over, word] of single) {
    const p = problemsOf(failingData({ findings: [finding(over)] }));
    assert.ok(has(p, '第 1 条发现', word), `${word}：${p.join(' / ')}`);
  }
  const ctl = String.fromCharCode(1);
  const texts = [['控制字符', `坏${ctl}字`], ['零宽空格', `a${ZW}b`], ['方向控制', `a${String.fromCodePoint(0x202e)}b`], ['行分隔符', `a${String.fromCodePoint(0x2028)}b`], ['段分隔符', `a${String.fromCodePoint(0x2029)}b`]];
  for (const [name, text] of texts) {
    const p = problemsOf(failingData({ findings: [finding({ problem: text })] }));
    assert.ok(has(p, '第 1 条发现', 'problem'), `${name}：${p.join(' / ')}`);
    const q = problemsOf(reviewData({ sections: { 范围: text, 作者的验证: '核对了。' } }));
    assert.ok(has(q, '范围'), `节里的${name}：${q.join(' / ')}`);
  }
  // 多行字段允许换行与制表符
  assert.deepEqual(problemsOf(failingData({ findings: [finding({ problem: '第一行\n第二行\t缩进' })] })), []);
  assert.deepEqual(problemsOf(reviewData({ sections: { 范围: '第一行\n第二行', 作者的验证: '核对了。' } })), []);
  // 节名也是单行
  assert.ok(problemsOf(reviewData({ sections: { 范围: '读了。', 作者的验证: '核对了。', '坏\n名': '有内容' } })).length > 0);
});

test('S2 超长：字段超过 4000 字、节超过 20000 字、发现超过 200 条拒绝，恰好在上限内放行', () => {
  assert.ok(has(problemsOf(failingData({ findings: [finding({ problem: 'x'.repeat(4001) })] })), '第 1 条发现', 'problem'));
  assert.deepEqual(problemsOf(failingData({ findings: [finding({ problem: 'x'.repeat(4000) })] })), []);
  assert.ok(has(problemsOf(reviewData({ sections: { 范围: 'x'.repeat(20001), 作者的验证: '核对了。' } })), '范围'));
  assert.deepEqual(problemsOf(reviewData({ sections: { 范围: 'x'.repeat(20000), 作者的验证: '核对了。' } })), []);
  const many = (n) => Array.from({ length: n }, (_, i) => finding({ id: `L${i + 1}`, severity: 'low' }));
  assert.ok(problemsOf(reviewData({ findings: many(201) })).length > 0);
  assert.deepEqual(problemsOf(reviewData({ findings: many(200) })), []);
});

test('S2 files：含 ..、反斜杠、绝对路径、空段、重复、空数组都拒绝', () => {
  const badFiles = [['../a.ts'], ['a/../b.ts'], [`a${BS}b.ts`], ['/etc/passwd'], ['a//b.ts'], ['./a.ts'], ['a/./b.ts'], ['a.ts', 'a.ts'], [], [''], [3], 'src/a.ts'];
  for (const files of badFiles) {
    const p = problemsOf(failingData({ findings: [finding({ files })] }));
    assert.ok(has(p, '第 1 条发现', 'files'), `${JSON.stringify(files)}：${p.join(' / ')}`);
  }
  assert.deepEqual(problemsOf(failingData({ findings: [finding({ files: ['src/a.ts', 'docs/04-开发/b.md'] })] })), []);
});

test('S2 sections：缺必需节、节没有内容、节值不是字符串都拒绝并指出节名；发现节不要求', () => {
  assert.ok(has(problemsOf(reviewData({ sections: { 范围: '读了。' } })), '作者的验证'));
  assert.ok(has(problemsOf(reviewData({ sections: { 作者的验证: '核对了。' } })), '范围'));
  assert.ok(has(problemsOf(reviewData({ sections: { 范围: '无', 作者的验证: '核对了。' } })), '范围'));
  assert.ok(has(problemsOf(reviewData({ sections: { 范围: '读了。', 作者的验证: '&nbsp;' } })), '作者的验证'));
  assert.ok(has(problemsOf(reviewData({ sections: { 范围: '读了。', 作者的验证: 3 } })), '作者的验证'));
  assert.ok(has(problemsOf(reviewData({ sections: { 范围: '读了。', 作者的验证: '核对了。', 额外: '' } })), '额外'));
  assert.deepEqual(problemsOf(reviewData({ sections: { 范围: '读了。', 作者的验证: '核对了。' } })), [], '数据里不必有发现节');
});

test('S2 pr 流程：reviewedCommit、reviewedBase 必须是 40 位小写十六进制', () => {
  const bads = [null, '', 'abc', 'g'.repeat(40), 'A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), 12];
  for (const v of bads) {
    assert.ok(has(problemsOf(prData({ reviewedCommit: v }), 'pr'), 'reviewedCommit'), `commit ${JSON.stringify(v)}`);
    assert.ok(has(problemsOf(prData({ reviewedBase: v }), 'pr'), 'reviewedBase'), `base ${JSON.stringify(v)}`);
  }
  assert.deepEqual(problemsOf(reviewData({ reviewedCommit: null, reviewedBase: null }), 'pre-push'), [], 'pre-push 可为 null');
});

test('S3 高、中级发现：位置、问题、触发条件、理由、建议改法逐栏缺内容各一行', () => {
  for (const severity of ['high', 'medium']) {
    for (const field of ['location', 'problem', 'trigger', 'reason', 'fix']) {
      for (const empty of ['', '   ', '无', '&nbsp;', ZW]) {
        const p = problemsOf(failingData({ findings: [finding({ severity, [field]: empty })] }));
        const lines = p.filter((x) => x.includes('第 1 条发现') && x.includes(field));
        assert.equal(lines.length, 1, `${severity}/${field}/${JSON.stringify(empty)}：${p.join(' / ')}`);
        assert.ok(lines[0].includes(severity === 'high' ? 'H1' : 'M1'), '写明编号');
      }
    }
  }
  const two = problemsOf(failingData({ findings: [finding({ trigger: '', fix: '' })] }));
  assert.ok(has(two, 'trigger') && has(two, 'fix'), `两栏都缺时各一行：${two.join(' / ')}`);
  assert.ok(two.length >= 2);
});

test('S3 低级和提示：只要求问题有内容，其余栏可空', () => {
  for (const [severity, id] of [['low', 'L1'], ['info', 'I1']]) {
    const lean = finding({ severity, id, location: '', trigger: '', reason: '', fix: '' });
    assert.deepEqual(problemsOf(reviewData({ findings: [lean] })), [], severity);
    const noProblem = finding({ severity, id, problem: '' });
    assert.ok(has(problemsOf(reviewData({ findings: [noProblem] })), '第 1 条发现', 'problem'), severity);
  }
});

test('S4 结论与发现一致：通过却有高、中级发现、未修处置、证据不足的缺口；不通过却没有高、中级', () => {
  for (const severity of ['high', 'medium']) {
    const p = problemsOf(reviewData({ verdict: 'pass', findings: [finding({ severity })] }));
    assert.ok(p.length > 0 && has(p, severity === 'high' ? 'H1' : 'M1'), `pass 含 ${severity}：${p.join(' / ')}`);
  }
  for (const status of ['partial', 'not-fixed']) {
    const p = problemsOf(reviewData({ verdict: 'pass', dispositions: [{ id: 'M1', status, evidence: '还没改完。' }] }));
    assert.ok(p.length > 0, `pass 含 ${status}`);
    assert.ok(has(p, status) || has(p, 'M1'), `pass 含 ${status}：${p.join(' / ')}`);
  }
  assert.deepEqual(problemsOf(reviewData({ verdict: 'pass', dispositions: [{ id: 'M1', status: 'fixed', evidence: '已改。' }] })), []);
  const insufficient = problemsOf(highPass({ testGaps: gaps({ layers: { status: 'insufficient', note: '没看到集成测试。' } }) }));
  assert.ok(insufficient.length > 0);
  assert.ok(has(insufficient, 'layers') || has(insufficient, 'insufficient'), insufficient.join(' / '));
  for (const findings of [[], [finding({ severity: 'low', id: 'L1' })], [finding({ severity: 'info', id: 'I1' })]]) {
    const p = problemsOf(reviewData({ verdict: 'fail', findings }));
    assert.ok(p.length > 0, `fail 只有低级或没有发现：${JSON.stringify(findings.map((f) => f.severity))}`);
  }
  assert.deepEqual(problemsOf(reviewData({ verdict: 'fail', findings: [finding({ severity: 'low', id: 'L1' }), finding({ severity: 'high', id: 'H1' })] })), []);
});

test('S6 风险高：必须有 testGaps，三项各有状态和说明', () => {
  const noGaps = problemsOf(reviewData({ risk: 'high' }));
  assert.ok(has(noGaps, 'testGaps'), noGaps.join(' / '));
  assert.ok(has(problemsOf(reviewData({ risk: 'high', testGaps: null })), 'testGaps'));
  assert.deepEqual(problemsOf(reviewData({ risk: 'low' })), [], '低风险可以没有 testGaps');
  assert.deepEqual(problemsOf(reviewData({ risk: 'low', testGaps: null })), []);
  for (const item of ['functions', 'layers', 'boundaries']) {
    const missing = gaps();
    delete missing[item];
    assert.ok(has(problemsOf(highPass({ testGaps: missing })), item), `缺 ${item}`);
    for (const note of ['', '无', '&nbsp;']) {
      const p = problemsOf(highPass({ testGaps: gaps({ [item]: { status: 'verified', note } }) }));
      assert.ok(has(p, item, 'note'), `${item} note ${JSON.stringify(note)}：${p.join(' / ')}`);
    }
    assert.ok(has(problemsOf(highPass({ testGaps: gaps({ [item]: { status: 'unknown', note: '说明。' } }) })), item, 'status'));
  }
  assert.ok(problemsOf(highPass({ testGaps: { ...gaps(), extra: { status: 'verified', note: '多出的项。' } } })).length > 0);
  for (const status of ['verified', 'n/a']) assert.deepEqual(problemsOf(highPass({ testGaps: gaps({ boundaries: { status, note: '说明。' } }) })), []);
});

test('S6 gap 状态：必须列出对应的高、中级发现编号，不能列低级或不存在的编号', () => {
  const failWith = (findings, gap) => failingData({ risk: 'high', findings, testGaps: gaps({ boundaries: gap }) });
  const mid = [finding({ id: 'M1' }), finding({ id: 'L1', severity: 'low' })];
  assert.deepEqual(problemsOf(failWith(mid, { status: 'gap', note: '边界没覆盖。', findings: ['M1'] })), []);
  for (const listed of [undefined, [], ['L1'], ['M9'], ['M1', 'L1'], 'M1']) {
    const gap = { status: 'gap', note: '边界没覆盖。' };
    if (listed !== undefined) gap.findings = listed;
    const p = problemsOf(failWith(mid, gap));
    assert.ok(has(p, 'boundaries'), `findings=${JSON.stringify(listed)}：${p.join(' / ')}`);
  }
});

test('S4 处置：id 不重复、状态在枚举内、evidence 有内容', () => {
  const d = (dispositions) => problemsOf(failingData({ dispositions }));
  assert.ok(has(d([{ id: 'M1', status: 'fixed', evidence: '已改。' }, { id: 'M1', status: 'fixed', evidence: '已改。' }]), 'M1'));
  assert.ok(has(d([{ id: 'M1', status: 'done', evidence: '已改。' }]), 'status'));
  for (const evidence of ['', '无', ' ']) assert.ok(has(d([{ id: 'M1', status: 'fixed', evidence }]), 'evidence'), JSON.stringify(evidence));
  assert.deepEqual(d([{ id: 'M1', status: 'partial', evidence: '改了一半。' }]), []);
});

test('S2 多个问题同时出现时全部列出，不在第一条停', () => {
  const data = failingData({
    kind: 'tests',
    findings: [finding({ trigger: '', fix: '' }), finding({ id: 'M1' })],
    sections: { 范围: '' },
  });
  const p = problemsOf(data);
  assert.ok(has(p, 'kind'));
  assert.ok(has(p, '第 1 条发现', 'trigger'));
  assert.ok(has(p, '第 1 条发现', 'fix'));
  assert.ok(has(p, 'M1') && p.some((x) => x.includes('第 2 条发现')), '重复编号也列出');
  assert.ok(has(p, '范围'));
  assert.ok(has(p, '作者的验证'));
  assert.ok(p.length >= 6, p.join(' / '));
});

test('S4 verdictOf：有高或中级即 fail，只有低级、提示或没有发现为 pass', () => {
  assert.equal(verdictOf([]), 'pass');
  assert.equal(verdictOf([finding({ severity: 'low', id: 'L1' }), finding({ severity: 'info', id: 'I1' })]), 'pass');
  assert.equal(verdictOf([finding({ severity: 'medium' })]), 'fail');
  assert.equal(verdictOf([finding({ severity: 'low', id: 'L1' }), finding({ severity: 'high', id: 'H1' })]), 'fail');
});

test('S5 fingerprint：键顺序不同结果相同，内容不同结果不同，是 64 位十六进制', () => {
  const x = failingData({ reviewedCommit: A, reviewedBase: M });
  const reordered = Object.fromEntries(Object.entries(x).reverse());
  reordered.findings = x.findings.map((f) => Object.fromEntries(Object.entries(f).reverse()));
  reordered.sections = Object.fromEntries(Object.entries(x.sections).reverse());
  assert.equal(fingerprint(reordered), fingerprint(x));
  assert.match(fingerprint(x), /^[0-9a-f]{64}$/);
  assert.notEqual(fingerprint({ ...x, verdict: 'pass' }), fingerprint(x));
  assert.notEqual(fingerprint({ ...x, findings: [finding({ problem: '不同的问题。' })] }), fingerprint(x));
  assert.notEqual(fingerprint({ ...x, sections: { ...x.sections, 范围: '改了。' } }), fingerprint(x));
});

test('S5 compactFindings：只留编号、级别、files、unresolvable、systemic、prior', () => {
  const c = compactFindings([finding({ files: ['src/a.ts'], systemic: true, prior: 'M3' }), finding({ id: 'L1', severity: 'low' })]);
  assert.equal(c.length, 2);
  assert.equal(c[0].id, 'M1');
  assert.equal(c[0].severity, 'medium');
  assert.deepEqual(c[0].files, ['src/a.ts']);
  assert.equal(c[0].systemic, true);
  assert.equal(c[0].prior, 'M3');
  assert.equal('problem' in c[0], false, '不带大段文本');
  assert.equal('reason' in c[0], false);
  assert.equal(c[1].id, 'L1');
});

test('H7 coverageOf：分叉点、覆盖链、基准等于被审提交、基准不是祖先、链断开', () => {
  const base = { reviewedBase: M, reviewedCommit: A, forkPoint: M, coveredCommits: [], baseIsAncestor: true };
  assert.equal(coverageOf(base).full, true, '基准等于分叉点');
  assert.equal(coverageOf({ ...base, reviewedBase: B, coveredCommits: [B] }).full, true, '基准是此前完整覆盖过的提交');
  assert.equal(coverageOf({ ...base, reviewedBase: B, coveredCommits: [M, B] }).full, true);
  const notFull = [
    [{ reviewedBase: A, reviewedCommit: A, forkPoint: A }, '基准等于被审提交'],
    [{ reviewedBase: A, reviewedCommit: A, forkPoint: M, coveredCommits: [A] }, '基准等于被审提交，哪怕被登记过'],
    [{ baseIsAncestor: false }, '基准不是被审提交的祖先'],
    [{ reviewedBase: B, coveredCommits: [] }, '中间提交，没有覆盖链'],
    [{ reviewedBase: B, coveredCommits: [M] }, '链断开：登记过的是别的提交'],
    [{ reviewedBase: B, forkPoint: null, coveredCommits: [] }, '算不出分叉点'],
    [{ reviewedBase: B, baseIsAncestor: false, coveredCommits: [B] }, '登记过但不是祖先'],
  ];
  for (const [over, name] of notFull) {
    const r = coverageOf({ ...base, ...over });
    assert.equal(r.full, false, name);
    assert.equal(typeof r.why, 'string', name);
    assert.ok(r.why.length > 0, `${name}：why 写明缺哪段`);
  }
});

/** admissionProblems 的 facts：默认是 pr 流程、低风险、通过、完整覆盖、没有历史的合格登记。 */
function facts(over = {}) {
  const { data = prData(), ...rest } = over;
  return { data, verdict: data.verdict, kind: 'code', flow: 'pr', prHead: A, prior: [], evidenceChecked: null, coverage: { full: true, why: '' }, missingFiles: [], ...rest };
}
const adm = (over) => admissionProblems(facts(over));
/** 历史里的一条记录（compact 后的样子）：默认是 B 上的代码复审 fail，含 M1。 */
const rec = (over = {}) => ({ kind: 'code', verdict: 'fail', headSha: B, risk: 'low', findings: [{ id: 'M1', severity: 'medium', files: [], unresolvable: false, systemic: false, prior: null }], coverage: 'full', ...over });
const failData = () => prData({ verdict: 'fail', findings: [finding()] });
const FIXED = { id: 'M1', status: 'fixed', evidence: 'diff 里已改。' };

test('S4 admissionProblems：合格登记返回空数组', () => {
  assert.deepEqual(adm(), []);
  assert.deepEqual(adm({ data: failData() }), []);
});

test('S4 admissionProblems：登记结论与数据结论不一致；accept 要求数据 fail；kind 不符', () => {
  assert.ok(has(adm({ data: prData(), verdict: 'fail' }), '结论'), 'data pass 却登记 fail');
  assert.ok(has(adm({ data: failData(), verdict: 'pass' }), '结论'), 'data fail 却登记 pass');
  assert.ok(adm({ data: prData(), verdict: 'accept' }).length > 0, 'accept 要求数据 fail');
  assert.deepEqual(adm({ data: failData(), verdict: 'accept' }), []);
  assert.ok(has(adm({ kind: 'consistency' }), 'kind'), '数据 kind 与登记 kind 不同');
});

test('H3 admissionProblems：被审提交与 PR 最终提交不同拒绝，文字含两个提交的前 12 位', () => {
  const p = adm({ prHead: B });
  assert.equal(p.length, 1, p.join(' / '));
  assert.ok(p[0].includes(A.slice(0, 12)) && p[0].includes(B.slice(0, 12)), p[0]);
  assert.deepEqual(adm({ prHead: A }), []);
});

test('H7 admissionProblems：部分覆盖时 pass、accept 拒绝并附原因，fail 放行', () => {
  const coverage = { full: false, why: '被审范围从 X 开始，分叉点是 Y，缺中间一段' };
  assert.ok(has(adm({ coverage }), '缺中间一段'), 'pass 拒绝并带原因');
  assert.ok(has(adm({ data: failData(), verdict: 'accept', coverage }), '缺中间一段'), 'accept 拒绝并带原因');
  assert.deepEqual(adm({ data: failData(), verdict: 'fail', coverage }), [], 'fail 放行');
});

test('S6 admissionProblems：风险高缺 evidenceChecked 拒绝，有内容放行；低风险不要求', () => {
  const high = prData({ risk: 'high', testGaps: gaps() });
  for (const empty of [null, undefined, '', '  ', '无']) {
    const p = adm({ data: high, evidenceChecked: empty });
    assert.ok(has(p, 'evidence') || has(p, '核对'), `${JSON.stringify(empty)}：${p.join(' / ')}`);
  }
  assert.deepEqual(adm({ data: high, evidenceChecked: '主对话重跑了新增的两个测试并核对了边界用例。' }), []);
  assert.deepEqual(adm({ evidenceChecked: null }), []);
});

test('S7 admissionProblems：此前有高风险登记，之后的 pass、accept 也须高风险；fail 不受限', () => {
  const prior = [rec({ risk: 'high', headSha: A })];
  assert.ok(has(adm({ prior }), '风险'), '低风险 pass 被拒');
  assert.ok(has(adm({ data: failData(), verdict: 'accept', prior }), '风险'), '低风险 accept 被拒');
  assert.deepEqual(adm({ data: failData(), verdict: 'fail', prior }), [], 'fail 不受限');
  const high = prData({ risk: 'high', testGaps: gaps() });
  assert.deepEqual(adm({ data: high, evidenceChecked: '核对了。', prior }), [], '高风险 pass 放行');
  assert.deepEqual(adm({ prior: [rec({ risk: 'low', headSha: A })] }), [], '此前只有低风险登记不受限');
  assert.deepEqual(adm({ prior: [rec({ risk: 'high', headSha: A, verdict: 'defer' })] }), [], 'defer 不算');
});

test('S8 admissionProblems：修后复核缺处置、多余处置、prior 指向不存在的编号', () => {
  const prior = [rec()]; // 上一次在 B 上 fail，含 M1；本次被审提交是 A
  assert.ok(has(adm({ prior }), 'M1'), '没有处置');
  assert.deepEqual(adm({ prior, data: prData({ dispositions: [FIXED] }) }), []);
  const extra = prData({ dispositions: [FIXED, { id: 'M9', status: 'fixed', evidence: '已改。' }] });
  assert.ok(has(adm({ prior, data: extra }), 'M9'), '多余的处置');
  const badPrior = prData({ verdict: 'fail', findings: [finding({ id: 'M2', prior: 'M7' })], dispositions: [FIXED] });
  assert.ok(has(adm({ prior, data: badPrior }), 'M7'), 'prior 指向不存在的编号');
});

test('S8 admissionProblems：未修好的处置必须有一条本轮高、中级发现用 prior 指向', () => {
  const prior = [rec()];
  const notFixed = { id: 'M1', status: 'not-fixed', evidence: '没改。' };
  const noPointer = prData({ verdict: 'fail', findings: [finding({ id: 'M2' })], dispositions: [notFixed] });
  assert.ok(has(adm({ prior, data: noPointer, verdict: 'fail' }), 'M1'), 'not-fixed 没有对应 prior 发现');
  const pointed = prData({ verdict: 'fail', findings: [finding({ id: 'M2', prior: 'M1' })], dispositions: [notFixed] });
  assert.deepEqual(adm({ prior, data: pointed, verdict: 'fail' }), []);
  const lowPointer = prData({ verdict: 'fail', findings: [finding({ id: 'M2' }), finding({ id: 'L1', severity: 'low', prior: 'M1' })], dispositions: [notFixed] });
  assert.ok(has(adm({ prior, data: lowPointer, verdict: 'fail' }), 'M1'), '低级发现的 prior 不算');
  const partial = prData({ verdict: 'fail', findings: [finding({ id: 'M2' })], dispositions: [{ id: 'M1', status: 'partial', evidence: '改了一半。' }] });
  assert.ok(has(adm({ prior, data: partial, verdict: 'fail' }), 'M1'), 'partial 同样要有 prior 发现');
});

test('S8 admissionProblems：没有上一次 fail 时不能给处置、不能写 prior；同提交、别的 kind 的 fail 不算', () => {
  assert.ok(adm({ data: prData({ dispositions: [FIXED] }) }).length > 0, '没有 prevFail 却给了处置');
  const withPrior = prData({ verdict: 'fail', findings: [finding({ prior: 'M1' })] });
  assert.ok(adm({ data: withPrior, verdict: 'fail' }).length > 0, '没有 prevFail 却写了 prior');
  assert.deepEqual(adm({ prior: [rec({ kind: 'consistency' })] }), [], '别的 kind 的 fail 不要求处置');
  assert.deepEqual(adm({ prior: [rec({ headSha: A })] }), [], '同一提交上的 fail 不算 prevFail');
  assert.deepEqual(adm({ prior: [rec({ verdict: 'pass', headSha: B })] }), [], '上一次是 pass 不要求处置');
  const two = [rec({ headSha: M, findings: [{ id: 'M5', severity: 'medium' }] }), rec({ headSha: B })];
  assert.deepEqual(adm({ prior: two, data: prData({ dispositions: [FIXED] }) }), [], '取同 kind 最后一条 fail');
});

test('S8 admissionProblems：低级发现不要求处置，只要求高、中级', () => {
  const prior = [rec({ findings: [{ id: 'H1', severity: 'high' }, { id: 'M1', severity: 'medium' }, { id: 'L1', severity: 'low' }] })];
  const both = [{ id: 'H1', status: 'fixed', evidence: '已改。' }, FIXED];
  assert.deepEqual(adm({ prior, data: prData({ dispositions: both }) }), []);
  assert.ok(has(adm({ prior, data: prData({ dispositions: [both[0]] }) }), 'M1'));
  const withLow = prData({ dispositions: [...both, { id: 'L1', status: 'fixed', evidence: '已改。' }] });
  assert.ok(has(adm({ prior, data: withLow }), 'L1'), '低级编号不在可处置范围');
});

test('S2 admissionProblems：missingFiles 逐个列出', () => {
  const p = adm({ missingFiles: ['src/nope.ts', 'docs/ghost.md'] });
  assert.ok(has(p, 'src/nope.ts') && has(p, 'docs/ghost.md'), p.join(' / '));
  assert.deepEqual(adm({ missingFiles: [] }), []);
});

test('S2 admissionProblems：pre-push 流程不做 H3、H7、S7、S8，仍做结论一致与 missingFiles', () => {
  const data = reviewData({ reviewedCommit: null, reviewedBase: null, dispositions: [FIXED] });
  const base = { data, kind: 'code', flow: 'pre-push', prHead: null, evidenceChecked: null, missingFiles: [] };
  const p = admissionProblems({ ...base, verdict: 'pass', prior: [rec({ risk: 'high' })], coverage: { full: false, why: '缺一段' } });
  assert.deepEqual(p, []);
  const bad = admissionProblems({ ...base, verdict: 'fail', prior: [], coverage: { full: true, why: '' }, missingFiles: ['x.ts'] });
  assert.ok(has(bad, '结论') && has(bad, 'x.ts'), bad.join(' / '));
});

test('S2 admissionProblems：多个问题同时出现时全部列出', () => {
  const data = prData({ risk: 'high', testGaps: gaps() });
  const p = admissionProblems({
    data, verdict: 'fail', kind: 'consistency', flow: 'pr', prHead: B,
    prior: [rec({ risk: 'high', headSha: M })], evidenceChecked: null, coverage: { full: false, why: '缺中间一段' }, missingFiles: ['src/gone.ts'],
  });
  assert.ok(has(p, '结论'), '结论不一致');
  assert.ok(has(p, 'kind'), 'kind 不符');
  assert.ok(p.some((x) => x.includes(A.slice(0, 12)) && x.includes(B.slice(0, 12))), 'H3');
  assert.ok(has(p, 'evidence') || has(p, '核对'), 'S6');
  assert.ok(has(p, 'src/gone.ts'), 'missingFiles');
  assert.ok(has(p, 'M1'), 'S8 缺处置');
  assert.ok(p.length >= 6, p.join(' / '));
});

/** 每行未转义的竖线个数（反斜杠后的字符不计）。 */
function pipeCounts(lines) {
  return lines.map((l) => {
    let n = 0;
    for (let i = 0; i < l.length; i += 1) {
      if (l[i] === BS) i += 1;
      else if (l[i] === '|') n += 1;
    }
    return n;
  });
}

test('S5 renderReport：特殊字符原样可见（转义后的形式），不破坏表格列数，七栏表头、结论、指纹都在', () => {
  const nasty = finding({
    id: 'M1',
    location: 'src/a|b.ts:1',
    problem: '用 *星号* 和 <b>标签</b> 与 a & b 以及 # 号。\n第二行文字',
    trigger: '输入 x|y 时。',
    reason: 'reason_with_underscore 与 `代码` 与 [链接](http://x)。',
    fix: '改成 <script>alert(1)</script>。',
  });
  const sections = { 范围: '第一行\n第二行 | 带竖线', 作者的验证: '核对了。' };
  const data = failingData({ reviewedCommit: A, reviewedBase: M, findings: [nasty, finding({ id: 'L1', severity: 'low', problem: '低级问题。' })], sections });
  const md = renderReport(data, { reviewer: 'feature-dev:code-reviewer', model: 'm-1', coverage: 'full', fingerprint: fingerprint(data) });
  assert.equal(typeof md, 'string');
  assert.ok(md.includes(`a${BS}|b.ts`), '位置里的竖线转义后可见');
  assert.ok(md.includes(`${BS}*星号${BS}*`), '星号转义后可见');
  assert.ok(!md.includes('<b>') && !md.includes('<script>'), '尖括号不能原样出现');
  assert.ok(md.includes(`${BS}<b${BS}>`) || md.includes("&lt;b&gt;"), "标签转义后可见");
  assert.ok(md.includes(`${BS}&`) || md.includes("&amp;"), "& 转义后可见");
  assert.ok(md.includes('<br>'), '单元格内换行转 <br>');
  assert.ok(md.includes('第二行文字'));
  assert.ok(md.includes(`x${BS}|y`));
  assert.ok(md.includes('> 第一行') && md.includes('> 第二行'), '节文字每行前加 > ');
  assert.ok(md.includes(fingerprint(data)), '指纹写在元信息里');
  assert.ok(md.includes('feature-dev:code-reviewer'));
  assert.match(md, /结论/);
  assert.match(md, /不通过/);
  const lines = md.split('\n');
  const header = lines.find((l) => l.startsWith('|') && ['编号', '级别', '位置', '问题', '触发条件', '理由', '建议改法'].every((w) => l.includes(w)));
  assert.ok(header, '七栏表头存在');
  const rows = lines.filter((l) => l.startsWith('|') && (l.includes('M1') || l.includes('L1')) && !l.includes('编号'));
  assert.ok(rows.length >= 2, '每条发现一行');
  const [headCount, ...rowCounts] = pipeCounts([header, ...rows]);
  assert.ok(headCount >= 6, `七栏至少 6 个分隔竖线：${headCount}`);
  for (const n of rowCounts) assert.equal(n, headCount, '发现行的列数与表头一致，文字里的竖线没有破坏表格');
  assert.ok(!lines.some((l) => l.startsWith('第二行文字')), '换行不能把单元格拆成独立的行');
});

test('S5 renderReport：通过的数据结论写通过；处置与测试缺口出现在报告里', () => {
  const data = highPass({ reviewedCommit: A, reviewedBase: M, dispositions: [{ id: 'M1', status: 'fixed', evidence: '补了空数组判断。' }] });
  const md = renderReport(data, { reviewer: 'r', coverage: 'full' });
  assert.match(md, /结论/);
  assert.match(md, /通过/);
  assert.ok(!/不通过/.test(md), '通过的数据不写不通过');
  assert.ok(md.includes('补了空数组判断。'));
  assert.ok(md.includes('每个功能点都有对应测试。'), '测试缺口说明可见');
});

test('S2 hasContent：占位词带标点或括号（“无。”“（暂无）”“N/A.”“- 无”）也算没有内容；正常句子不受影响', () => {
  for (const s of ['无。', '暂无！', '（无）', '“无”', 'N/A.', 'TBD!', '- 无', '待补…', '无；']) assert.equal(hasContent(s), false, JSON.stringify(s));
  for (const s of ['无法复现。', '无（见 M1）', '没有无', 'none of the callers check it.']) assert.equal(hasContent(s), true, JSON.stringify(s));
});
