// 断言有效性检查：本次改动的测试文件里要有断言的痕迹；测试用例数比基准提交少时给提示（同一路径比较；改名按改名前的文件比较，配不上对的按删除与新增文件的总数比较）。
// 业务含义：测试先行检查只看测试有没有引用模块，引用了却什么都不断言（只打印、只调用）的测试同样能通过闸门。
// 这里用一组宽松的正则找“断言痕迹”，找不到就判静态检查不过；用例数减少不拦，交给复审者核对是不是有意删的。
// 局限：只是文本匹配，不理解代码——注释里写了 assert、断言写在被导入的辅助函数里、用了这里没列的断言库，
// 都会让判断出错；确实没有断言的测试（例如只验证能导入的冒烟测试）在豁免表的 assertions 段写明理由。
import fs from 'node:fs';
import path from 'node:path';
import { EMPTY_TREE, git, isIgnoredDoc, isTestFile } from './lib.mjs';

/**
 * 断言痕迹（宽松，命中任一即算有断言）：JS/TS 的 assert、expect、should、ava/tap 的 t.is 等，C#/NUnit 的 Assert.，Swift 的 XCTAssert，
 * Kotest 的 shouldXxx，Python 的 assert 语句、pytest.raises、unittest 的 self.assertXxx，Java/Kotlin 的 assertXxx，Ruby 的 assert_xxx，
 * Go 的 testify require./assert. 与 t.Error/Fatal 等，Rust 的 assert! 系列。
 */
export const ASSERTION_PATTERNS = [
  /\bassert\s*[.(]/i, // assert(x)、assert.equal(...)、C# 与 NUnit 的 Assert.AreEqual(...)、Assert.That(...)
  /^\s*assert\s+\S/m, // Python 的 assert 语句
  /\bassert[A-Z_]\w*\s*\(/, // assertEquals(...)、assertThat(...)、self.assertEqual(...)
  /\bassert_\w+\s+\S/, // 不带括号的 assert_xxx（Ruby minitest 的 assert_equal 1, a、assert_raises X）
  /\bassert\w*!\s*\(/, // Rust 的 assert!、assert_eq!、assert_ne!
  /\bXCTAssert\w*\s*\(/, // Swift 的 XCTAssert、XCTAssertEqual
  /\bshould[A-Z]\w*/, // Kotest 的 shouldBe、shouldThrow、shouldContain 等
  /\bexpect\s*\(/, // Jest、Vitest、Chai 的 expect(...)
  /\.should\b|\bshould\s*[.(]/, // should.js、Chai 的 should
  /\bt\.(?:is|not|ok|notOk|true|false|truthy|falsy|equal|notEqual|deepEqual|notDeepEqual|strictEqual|same|notSame|like|regex|throws|throwsAsync|notThrows|rejects|resolves|match|snapshot|assert|fail|pass)\s*\(/, // ava、tap、node:test 的 t.xxx
  /\bpytest\.(?:raises|approx|warns|fail)\b/, // pytest
  /\brequire\.(?!resolve\b|cache\b|main\b)\w+\s*\(/, // Go testify 的 require.Xxx（排除 Node 的 require.resolve、require.cache、require.main）
  /\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(/, // Go testing
];

/**
 * 不查断言的文件名：Python 的包标记和 pytest 的公共夹具文件，它们落在测试目录里、会被 testGlobs 匹配，但本来就不写断言。
 * 其他语言的测试辅助文件（如 tests/helpers.ts）不按名字猜：把 testGlobs 写成只匹配测试本身（如 *.test.ts），或在豁免表里写理由。
 */
export const NO_ASSERTION_NAMES = new Set(['__init__.py', 'conftest.py']);

/** 测试用例的写法：JS/TS 的 test( 与 it(（前面紧挨点号的不算，如正则的 re.test(s)），Python 的 def test_，Go 的 func Test。 */
export const TEST_CASE_PATTERNS = [/(?<!\.)\b(?:test|it)\s*\(/g, /^\s*(?:async\s+)?def\s+test_/gm, /^func\s+Test\w*\s*\(/gm];

/** 文本里有没有断言痕迹。 */
export function hasAssertion(text) {
  return ASSERTION_PATTERNS.some((re) => re.test(text));
}

/** 文本里测试用例的个数（各写法出现次数之和）。 */
export function countTestCases(text) {
  return TEST_CASE_PATTERNS.reduce((n, re) => n + (String(text).match(re) || []).length, 0);
}

/**
 * 基准提交到工作区之间 git 配上对的改名（只看已跟踪的文件，含暂存的 git mv 与已提交的改名）：返回 Map(新路径 → 旧路径)。
 * 只用于用例数比较；改动文件列表本身仍按 --no-renames 取（lib.mjs 的 diffNames）。git 失败时返回空表（只少一条提示，不影响判定）。
 */
function renamePairs(root, baseRev) {
  const r = git(root, ['diff', '-M', '--name-status', '-z', '--diff-filter=R', baseRev]);
  const pairs = new Map();
  if (!r.ok) return pairs;
  const parts = r.out.split('\0');
  for (let i = 0; i + 2 < parts.length; i += 3) {
    if (parts[i].startsWith('R')) pairs.set(parts[i + 2].replace(/\\/g, '/'), parts[i + 1].replace(/\\/g, '/'));
  }
  return pairs;
}

/**
 * 用例数比较（只提示，不拦截）。tests 是本次改动的测试文件（已按 testGlobs、reviewIgnore 过滤，含已删除的）。
 *   同一路径：比基准提交上的同一文件少时提示 { file, before, after, removed }。
 *   改名（git 配上对的）：按改名前的文件比较，提示多带 from（旧路径）。
 *   配不上对的（内容改得太多、或只在工作区 mv 而没 git add）：已删除的测试文件的用例总数，与新增的测试文件（基准上没有）的用例总数比较，
 *   新增的少时提示一条 { file: null, deleted, added, before, after, removed }。删掉测试文件、没有新增的，同样提示。
 *   局限（按总数比较的代价，见套件 SKILL.md 第 6 节）：同一分支上新增的无关测试文件会把减少的用例抵消掉（漏提示）；
 *   把一个测试文件的用例并进另一个已有文件再删掉它，并进去的用例不计入新增，会被提示为减少（误报）。只提示不拦截，所以不再细分。
 */
function caseHints(root, tests, baseRev) {
  const hints = [];
  const baseText = new Map(); // 每个路径只读一次基准提交上的内容（已删除的文件先判存在、后算总数，会用到两次）
  const atBase = (f) => {
    if (!baseText.has(f)) {
      const r = git(root, ['show', `${baseRev}:${f}`]);
      baseText.set(f, r.ok ? r.out : null);
    }
    return baseText.get(f);
  };
  const exists = (f) => fs.existsSync(path.join(root, f)) && fs.statSync(path.join(root, f)).isFile();
  const current = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const pairs = renamePairs(root, baseRev);
  const paired = new Set();
  const deleted = [];
  const added = [];
  for (const f of tests) {
    if (!exists(f)) {
      if (atBase(f) !== null) deleted.push(f);
      continue;
    }
    const from = pairs.get(f);
    if (from && tests.includes(from)) {
      paired.add(from);
      const before = countTestCases(atBase(from) ?? '');
      const after = countTestCases(current(f));
      if (after < before) hints.push({ file: f, from, before, after, removed: before - after });
      continue;
    }
    const old = atBase(f);
    if (old === null) {
      added.push(f);
      continue;
    }
    const before = countTestCases(old);
    const after = countTestCases(current(f));
    if (after < before) hints.push({ file: f, before, after, removed: before - after });
  }
  const gone = deleted.filter((f) => !paired.has(f));
  if (gone.length > 0) {
    const before = gone.reduce((n, f) => n + countTestCases(atBase(f)), 0);
    const after = added.reduce((n, f) => n + countTestCases(current(f)), 0);
    if (after < before) hints.push({ file: null, deleted: gone, added, before, after, removed: before - after });
  }
  return hints;
}

/**
 * 检查本次改动的测试文件。changed 为本次改动；baseRev 为基准提交（为空树或缺省时不比较用例数）；exempt 为豁免表 assertions 段。
 * 返回 { problems: [{ file, message }], hints（见 caseHints）, stats: { checked, exempt } }。
 * 已删除的测试文件、reviewIgnore 之内的、NO_ASSERTION_NAMES 里的（__init__.py、conftest.py）不查断言；已删除的仍参与用例数比较。
 */
export function checkAssertions({ root, changed, config, exempt = {}, baseRev = null }) {
  const problems = [];
  const stats = { checked: 0, exempt: 0 };
  const tests = changed.filter((x) => isTestFile(x, config) && !isIgnoredDoc(x, config.reviewIgnore));
  for (const f of tests) {
    const abs = path.join(root, f);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    const text = fs.readFileSync(abs, 'utf8');
    if (exempt[f]) stats.exempt++;
    else if (NO_ASSERTION_NAMES.has(path.posix.basename(f))) {
      // 包标记与公共夹具文件不查断言，也不计入检查数
    } else {
      stats.checked++;
      if (!hasAssertion(text)) {
        problems.push({ file: f, message: `${f}：测试文件里找不到任何断言（assert、expect、should 等）；只调用或打印不算测试。确实不需要断言的，在豁免表 assertions 段写明理由` });
      }
    }
  }
  const hints = baseRev && baseRev !== EMPTY_TREE ? caseHints(root, tests, baseRev) : [];
  return { problems, hints, stats };
}

/** 用例数减少的提示行（gate 输出用）：同一路径、改名（写明旧路径）、配不上对时按总数比较，三种写法。 */
export function testCaseHintMessages(hints) {
  const tail = '不拦截，请复审者核对是否有意删除';
  return hints.map((h) => {
    if (h.file === null) {
      const added = h.added.length > 0 ? `新增的测试文件（${h.added.join('、')}）共 ${h.after} 个` : '没有新增测试文件';
      return `提示：删除的测试文件（${h.deleted.join('、')}）共 ${h.before} 个用例，${added}，测试用例数比基准提交减少 ${h.removed} 个（${h.before} → ${h.after}；改名配不上对时按总数比较），${tail}`;
    }
    const from = h.from ? `（由 ${h.from} 改名）` : '';
    return `提示：${h.file}${from} 的测试用例数比基准提交减少 ${h.removed} 个（${h.before} → ${h.after}），${tail}`;
  });
}
