// 断言有效性检查：本次改动的测试文件里要有断言的痕迹；测试用例数比基准提交上的同一文件少时给提示。
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
 * 检查本次改动的测试文件。changed 为本次改动；baseRev 为基准提交（为空树或缺省时不比较用例数）；exempt 为豁免表 assertions 段。
 * 返回 { problems: [{ file, message }], hints: [{ file, before, after, removed }], stats: { checked, exempt } }。
 * 已删除的测试文件、reviewIgnore 之内的、NO_ASSERTION_NAMES 里的（__init__.py、conftest.py）不查断言。
 */
export function checkAssertions({ root, changed, config, exempt = {}, baseRev = null }) {
  const problems = [];
  const hints = [];
  const stats = { checked: 0, exempt: 0 };
  for (const f of changed.filter((x) => isTestFile(x, config) && !isIgnoredDoc(x, config.reviewIgnore))) {
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
    if (baseRev && baseRev !== EMPTY_TREE) {
      const old = git(root, ['show', `${baseRev}:${f}`]);
      if (old.ok) {
        const before = countTestCases(old.out);
        const after = countTestCases(text);
        if (after < before) hints.push({ file: f, before, after, removed: before - after });
      }
    }
  }
  return { problems, hints, stats };
}

/** 用例数减少的提示行（gate 输出用）。 */
export function testCaseHintMessages(hints) {
  return hints.map((h) => `提示：${h.file} 的测试用例数比基准提交减少 ${h.removed} 个（${h.before} → ${h.after}），不拦截，请复审者核对是否有意删除`);
}
