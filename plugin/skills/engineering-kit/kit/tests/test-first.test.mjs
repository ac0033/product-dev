// 测试先行检查的回归测试：同名模块、index 入口、CommonJS、不支持的语言这几类“误放行”都要被拦住或如实报告。
// 判断依据是测试文件 import 的路径按其所在目录解析后，是否就是改动的那个源文件；只比模块名会让同名文件互相放行。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkTestFirst, isReexportOnly, referencesFile } from '../gate/check-test-first.mjs';
import { runGate } from '../gate/gate.mjs';
import { featureRepo, tmpRepo, write } from './helpers.mjs';

/** 源码与测试都不限语言的配置：src/ 下是源文件，test/ 下是测试。 */
const cfg = { sourceGlobs: ['src/**'], testGlobs: ['test/**'] };
const HEADER = '// 示例模块：测试先行检查的回归夹具。\n';

/** 在临时仓库里写入文件并检查 changed 里的源文件，返回 { problems, stats }。 */
function run(files, changed, requireTestChange = true) {
  const root = tmpRepo();
  for (const [rel, text] of Object.entries(files)) write(root, rel, text);
  const stats = {};
  const problems = checkTestFirst({ root, changed, config: cfg, exempt: {}, requireTestChange, stats });
  return { problems, stats };
}

test('index.js 含业务逻辑：不能因文件名是 index 就跳过', () => {
  const { problems, stats } = run({ 'src/index.js': `${HEADER}export function run(x) {\n  return x * 2;\n}\n` }, ['src/index.js']);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /没有引用它的测试/);
  assert.equal(stats.skipped, 0);
});

test('index.js 只有再导出（export … from、export *，含注释）：跳过，记为无需测试', () => {
  const text = `${HEADER}/* 汇总出口 */\nexport * from './a.js';\nexport * as b from './b.js';\nexport { c, d as e } from './c.js';\nexport type { T } from './t.js';\n`;
  const { problems, stats } = run({ 'src/index.js': text }, ['src/index.js']);
  assert.deepEqual(problems, []);
  assert.equal(stats.skipped, 1);
  assert.equal(stats.checked, 0);
});

test('再导出之外还有一句逻辑：要检查', () => {
  assert.equal(isReexportOnly(`export * from './a.js';\nexport const x = 1;\n`, '.js'), false);
  assert.equal(isReexportOnly(`export * from './a.js';\nsetup();\n`, '.js'), false);
  assert.equal(isReexportOnly(`export { a } from './a.js';\n`, '.js'), true);
  // 多行花括号
  assert.equal(isReexportOnly(`export {\n  a,\n  b,\n} from './a.js';\n`, '.ts'), true);
});

test('Python __init__.py：只有导入和 __all__ 才跳过，有函数定义要检查', () => {
  assert.equal(isReexportOnly(`"""包说明。"""\nfrom .a import x\nfrom .b import (\n    y,\n    z,\n)\nimport os\n__all__ = ['x', 'y']\n`, '.py'), true);
  assert.equal(isReexportOnly(`from .a import x\n\ndef helper():\n    return 1\n`, '.py'), false);
  const { problems } = run({ 'src/pkg/__init__.py': 'def helper():\n    return 1\n' }, ['src/pkg/__init__.py']);
  assert.equal(problems.length, 1);
});

test('同名文件：测试只 import src/b/util.js 时，改动 src/a/util.js 仍报没有测试', () => {
  const files = {
    'src/a/util.js': `${HEADER}export function ua() {\n  return 'a';\n}\n`,
    'src/b/util.js': `${HEADER}export function ub() {\n  return 'b';\n}\n`,
    'test/b.test.js': "import { ub } from '../src/b/util.js';\nassert.equal(ub(), 'b');\n",
  };
  const a = run(files, ['src/a/util.js', 'test/b.test.js']);
  assert.equal(a.problems.length, 1, JSON.stringify(a.problems));
  assert.match(a.problems[0].message, /src\/a\/util\.js：没有引用它的测试/);
  const b = run(files, ['src/b/util.js', 'test/b.test.js']);
  assert.deepEqual(b.problems, []);
});

test('同名文件：引用的测试没有随改动一起改时，只认指向本文件的那份测试', () => {
  const files = {
    'src/a/util.js': `${HEADER}export function ua() {\n  return 'a';\n}\n`,
    'test/a.test.js': "import { ua } from '../src/a/util.js';\nassert.equal(ua(), 'a');\n",
    'test/b.test.js': "import { ub } from '../src/b/util.js';\nassert.equal(ub(), 'b');\n",
  };
  // 只改了无关的 b 测试：a 的实现改了、a 的测试没改
  const { problems } = run(files, ['src/a/util.js', 'test/b.test.js']);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /没有随改动一起改/);
  assert.match(problems[0].message, /test\/a\.test\.js/);
});

test('相对路径按测试文件所在目录解析：深层测试目录、去扩展名、目录 index 都认', () => {
  const src = 'src/a/util.js';
  assert.equal(referencesFile("import { x } from '../../src/a/util';", 'test/deep/x.test.js', src), true);
  assert.equal(referencesFile("import { x } from '../../src/a/util.js';", 'test/deep/x.test.js', src), true);
  assert.equal(referencesFile("import { x } from '../src/a/util';", 'test/deep/x.test.js', src), false, '从 test/deep 出发 ../src 是 test/src');
  assert.equal(referencesFile("const x = require('../src/a/util');", 'test/x.test.js', src), true);
  assert.equal(referencesFile("const x = await import('../src/a/util.js');", 'test/x.test.js', src), true);
  assert.equal(referencesFile("import '../src/a/util.js';", 'test/x.test.js', src), true);
  assert.equal(referencesFile("import { x } from '../src/a/util-more.js';", 'test/x.test.js', src), false);
  // TS 项目常见写法：import 写 .js，文件是 .ts
  assert.equal(referencesFile("import { x } from '../src/a/util.js';", 'test/x.test.ts', 'src/a/util.ts'), true);
  // 目录导入指向 index
  assert.equal(referencesFile("import { x } from '../src/a';", 'test/x.test.js', 'src/a/index.js'), true);
  assert.equal(referencesFile("import { x } from '../src/b';", 'test/x.test.js', 'src/a/index.js'), false);
});

test('非相对路径（别名、包名）：写出的路径必须是源文件路径的后缀，单段名不算', () => {
  const src = 'src/a/util.js';
  assert.equal(referencesFile("import { x } from '@/a/util';", 'test/x.test.js', src), true);
  assert.equal(referencesFile("import { x } from 'src/a/util';", 'test/x.test.js', src), true);
  assert.equal(referencesFile("import { x } from 'pkg/src/a/util.js';", 'test/x.test.js', src), true);
  assert.equal(referencesFile("import { x } from '@/b/util';", 'test/x.test.js', src), false);
  assert.equal(referencesFile("import util from 'util';", 'test/x.test.js', src), false, 'Node 内置的 util 不是本文件');
  assert.equal(referencesFile("import util from 'node:util';", 'test/x.test.js', src), false);
});

test('Python：按包路径解析，同名模块互不放行；相对导入按测试所在目录解析', () => {
  const a = 'src/pkg_a/util.py';
  assert.equal(referencesFile('from pkg_a.util import f\n', 'test/test_x.py', a), true);
  assert.equal(referencesFile('from pkg_a import util\n', 'test/test_x.py', a), true);
  assert.equal(referencesFile('from pkg_a import tools, util\n', 'test/test_x.py', a), true);
  assert.equal(referencesFile('import pkg_a.util\n', 'test/test_x.py', a), true);
  assert.equal(referencesFile('from pkg_b.util import f\n', 'test/test_x.py', a), false);
  assert.equal(referencesFile('from pkg_b import util\n', 'test/test_x.py', a), false);
  assert.equal(referencesFile('from pkg_a import util_helpers\n', 'test/test_x.py', a), false);
  assert.equal(referencesFile('from ..src.pkg_a import util\n', 'test/test_x.py', a), true);
  assert.equal(referencesFile('from ..src.pkg_b import util\n', 'test/test_x.py', a), false);
  // 包的 __init__.py 对应包名
  assert.equal(referencesFile('import pkg_a\n', 'test/test_x.py', 'src/pkg_a/__init__.py'), true);
  assert.equal(referencesFile('from pkg_a import f\n', 'test/test_x.py', 'src/pkg_a/__init__.py'), true);
  // 单段模块名：源文件在 src/ 下或与测试同目录才认
  assert.equal(referencesFile('import util\n', 'test/test_x.py', 'src/util.py'), true);
  assert.equal(referencesFile('import util\n', 'test/test_x.py', 'src/pkg_a/util.py'), false);
  assert.equal(referencesFile('import util\n', 'test/test_x.py', 'test/util.py'), true);
});

test('CommonJS：module.exports 与 exports.x 的文件也要求测试', () => {
  for (const body of ['module.exports = { run };\n', 'module.exports.run = run;\n', 'exports.run = run;\n']) {
    const { problems, stats } = run({ 'src/lib.cjs': `${HEADER}function run() {\n  return 1;\n}\n${body}` }, ['src/lib.cjs']);
    assert.equal(problems.length, 1, body);
    assert.equal(stats.checked, 1, body);
  }
  const ok = run(
    { 'src/lib.cjs': `${HEADER}module.exports = { run() {} };\n`, 'test/lib.test.cjs': "const { run } = require('../src/lib.cjs');\nrun();\n" },
    ['src/lib.cjs', 'test/lib.test.cjs'],
  );
  assert.deepEqual(ok.problems, []);
});

test('不支持的语言（如 Go）：不算“无需测试”，计入未检查并列出文件；不判不通过', () => {
  const { problems, stats } = run({ 'src/main.go': 'package main\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n' }, ['src/main.go']);
  assert.deepEqual(problems, []);
  assert.equal(stats.unchecked, 1);
  assert.deepEqual(stats.uncheckedFiles, ['src/main.go']);
  assert.equal(stats.skipped, 0);
  assert.equal(stats.checked, 0);
});

test('没有任何可测导出的 JS 文件仍算无需测试；已删除的源文件也算无需测试', () => {
  const { problems, stats } = run({ 'src/script.js': `${HEADER}console.log('hi');\n` }, ['src/script.js', 'src/gone.js']);
  assert.deepEqual(problems, []);
  assert.equal(stats.skipped, 2);
  assert.equal(stats.unchecked, 0);
});

test('闸门输出：测试先行通过行之后列出“未检查”的文件，不混进“无需测试”', () => {
  const root = featureRepo({ sourceGlobs: ['src/**/*.ts', 'src/**/*.go'] });
  write(root, 'src/main.go', '// 示例：Go 源文件，测试先行检查识别不了它的测试引用。\npackage main\n');
  const res = runGate({ root });
  assert.equal(res.ok, true, res.messages.join('\n'));
  assert.ok(res.messages.some((m) => /^测试先行检查通过.*无需测试 0 个/.test(m)), res.messages.join('\n'));
  assert.ok(res.messages.some((m) => /^\s*未检查 1 个.*src\/main\.go/.test(m)), res.messages.join('\n'));
});
