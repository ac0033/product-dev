// JUnit XML 样例生成（测试支持）：覆盖 node --test、vitest、pytest 三种写法。路径按调用方给的绝对路径写进去，
// 所以同一份样例在 Linux 与 Windows 上都能用（Windows 反斜杠的专门用例在测试里另造）。
const decl = '<?xml version="1.0" encoding="utf-8"?>\n';

/** node --test 的真实写法：顶层 testsuites 下直接出现 testcase（带 file 与 classname="test"），testsuite 内用例的失败既有 failure 属性也有 failure 子元素，另有 "<!-- tests 4 -->" 这类注释。 */
export function nodeTestXml({ a, b }) {
  return `${decl}<testsuites>
<!-- tests 4 -->
<!-- pass 3 -->
<!-- fail 1 -->
<testcase name="top level ok" time="0.250" classname="test" file="${a}"/>
<testcase name="top level second" time="0.500" classname="test" file="${a}"/>
<testsuite name="grp" time="0.01" disabled="0" errors="0" tests="2" failures="1" skipped="0" hostname="h" file="${b}">
<testcase name="x ok" time="0.002" classname="test"/>
<testcase name="x bad" time="0.003" classname="test" failure="1 == 2"><failure type="testCodeFailure" message="1 == 2">Error [ERR_ASSERTION]: 1 == 2
    at TestContext.&lt;anonymous> (file:///x/y.mjs:3:3)</failure></testcase>
</testsuite>
</testsuites>
`;
}

/** vitest 写法：testsuite 的 name 就是文件路径（相对仓库根），用例的 classname 同。 */
export function vitestXml(rel) {
  return `${decl}<testsuites name="vitest tests" tests="2" failures="1" errors="0" time="0.5">
<testsuite name="${rel}" timestamp="2026-11-27T00:00:00.000Z" hostname="h" tests="2" failures="1" errors="0" skipped="0" time="0.4">
<testcase classname="${rel}" name="adds" time="0.1"></testcase>
<testcase classname="${rel}" name="subtracts" time="0.3"><failure message="expected 1 to be 2" type="AssertionError">AssertionError: expected 1 to be 2</failure></testcase>
</testsuite>
</testsuites>
`;
}

/** pytest 写法：testsuite name 是 pytest，用例 classname 为点分模块名（tests.test_a），没有 file 属性。 */
export function pytestXml(classname) {
  return `${decl}<testsuites>
<testsuite name="pytest" errors="0" failures="0" skipped="1" tests="2" time="0.2" timestamp="2026-11-27T00:00:00" hostname="h">
<testcase classname="${classname}" name="test_one" time="0.100"/>
<testcase classname="${classname}" name="test_two" time="0.100"><skipped type="pytest.skip" message="later">later</skipped></testcase>
</testsuite>
</testsuites>
`;
}
