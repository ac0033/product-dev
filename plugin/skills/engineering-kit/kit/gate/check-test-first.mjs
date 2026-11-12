// 测试先行检查：改动的每个源文件都要有引用它的测试；有实现改动时，引用它的测试也必须在本次改动里。
// 业务含义：防止“只写实现、不写测试”，或“改了实现、测试没跟着变”。
// 判断依据：测试文件里 import / require / from 语句的路径，按测试文件所在目录解析后，指向的就是这个源文件（不只比模块名，同名文件互不放行）。
// 支持 JS/TS（.js .mjs .cjs .jsx .ts .mts .cts .tsx）与 Python（.py）；其他语言（如 Go、Rust）识别不了引用关系，
// 计入“未检查”并列出文件，不算“无需测试”，也不判不通过，项目自行保证并在豁免表里写理由。
// 局限：只有再导出（export … from）的入口文件不要求测试；测试经别的入口间接引用源文件的，识别不出，应在豁免表里写理由。
import fs from 'node:fs';
import path from 'node:path';
import { git, isSourceFile, isTestFile } from './lib.mjs';

/** 有可测导出的标志：ES 模块 export、CommonJS 的 module.exports / exports.x、Python 的 def / class。 */
const VALUE_EXPORT = /\bexport\b|\bmodule\.exports\b|\bexports\s*(?:\.|\[)|^\s*(def|class)\s/m;
const JS_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx']);
const PY_EXT = new Set(['.py']);

const posix = path.posix;
const stripExt = (p, exts) => (exts.has(posix.extname(p)) ? p.slice(0, -posix.extname(p).length) : p);

/** 去掉 JS 的块注释和整行/行尾注释（不处理字符串里的 //，再导出语句的路径里不会有）。 */
function stripJsComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
}

/**
 * 文件是否只有再导出（没有可测的行为）。
 * JS/TS：全部语句都是 export … from / export * from；Python：只有 import、from … import、__all__ 与文档字符串。
 */
export function isReexportOnly(text, ext) {
  if (PY_EXT.has(ext)) {
    const rest = text
      .replace(/("""|''')[\s\S]*?\1/g, '')
      .replace(/#.*$/gm, '')
      .replace(/__all__\s*\+?=\s*[[(][^\])]*[\])]/g, '')
      .replace(/^\s*from\s+[\w.]+\s+import\s+(?:\([^)]*\)|(?:[^\n\\]|\\\n)*)/gm, '')
      .replace(/^\s*import\s+[^\n]+/gm, '');
    return rest.trim() === '' && text.trim() !== '';
  }
  const reexport = /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"][^'"\n]+['"](?:\s+(?:with|assert)\s*\{[^}]*\})?\s*;?/g;
  const rest = stripJsComments(text).replace(/^\s*['"]use strict['"];?/, '').replace(reexport, '');
  return rest.trim() === '' && reexport.test(stripJsComments(text));
}

/** 测试里 import / require / from 的全部路径（JS/TS 写法，含动态 import 和 side-effect import）。 */
function jsSpecifiers(text) {
  return [...text.matchAll(/(?:\bfrom|\bimport|\brequire)\s*\(?\s*(['"`])([^'"`\n]+)\1/g)].map((m) => m[2]);
}

/** JS/TS：路径 spec 是否指向源文件 src（相对路径按测试所在目录解析；别名、包名路径要求是源文件路径的后缀）。 */
function jsReferences(text, testRel, srcRel) {
  const srcNoExt = stripExt(srcRel, JS_EXT);
  const targets = [srcNoExt, ...(posix.basename(srcNoExt) === 'index' ? [posix.dirname(srcNoExt) === '.' ? '' : posix.dirname(srcNoExt)] : [])];
  return jsSpecifiers(text).some((spec) => {
    if (spec.startsWith('node:')) return false;
    const base = stripExt(spec, JS_EXT);
    if (spec.startsWith('.')) {
      const resolved = posix.normalize(posix.join(posix.dirname(testRel), base)).replace(/^\.$/, '');
      return targets.includes(resolved);
    }
    const p = base.replace(/^[@~#]\//, '');
    return targets.some((t) => t === p || (p.includes('/') && t.endsWith(`/${p}`)) || (t.includes('/') && p.endsWith(`/${t}`)));
  });
}

/** Python：import 语句涉及的候选模块路径。相对导入（rel 为 true）已按测试所在目录解析成仓库路径，绝对导入只有包路径。 */
function pyCandidates(text, testRel) {
  const out = [];
  const names = (s) => {
    const t = s.replace(/#.*$/gm, '').replace(/\bas\s+\w+/g, '').split(/[\s,()\\]+/).filter((x) => /^\w+$/.test(x));
    return t;
  };
  for (const m of text.matchAll(/^\s*from\s+(\.*)([\w.]*)\s+import\s+(\([^)]*\)|(?:[^\n\\]|\\\n)*)/gm)) {
    const mod = m[2].replace(/\./g, '/');
    let base = mod;
    const rel = m[1].length > 0;
    if (rel) {
      let dir = posix.dirname(testRel);
      for (let i = 1; i < m[1].length; i++) dir = posix.dirname(dir);
      base = posix.normalize(posix.join(dir, mod));
    }
    for (const c of [base, ...names(m[3]).map((n) => posix.join(base, n))]) out.push({ path: c.replace(/^\.$/, ''), rel });
  }
  for (const m of text.matchAll(/^\s*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)/gm)) {
    for (const item of m[1].split(',')) out.push({ path: item.trim().split(/\s+/)[0].replace(/\./g, '/'), rel: false });
  }
  return out;
}

/** Python：测试是否 import 了源文件 src（包的 __init__.py 对应包名）。 */
function pyReferences(text, testRel, srcRel) {
  const noExt = stripExt(srcRel, PY_EXT);
  const mod = posix.basename(noExt) === '__init__' ? posix.dirname(noExt).replace(/^\.$/, '') : noExt;
  const testDir = posix.dirname(testRel);
  return pyCandidates(text, testRel).some(({ path: c, rel }) => {
    if (rel) return c === mod;
    if (c === mod) return true;
    if (!mod.endsWith(`/${c}`)) return false;
    // 单段模块名（import util）太容易撞名：源文件在 src/、lib/ 或与测试同目录才认
    return c.includes('/') || ['src', 'lib', testDir].includes(posix.dirname(mod));
  });
}

/**
 * 测试文本 text（文件 testRel）是否引用了源文件 srcRel：import 路径按测试所在目录解析后与源文件路径比较。
 * 测试文件的扩展名决定按 JS 还是 Python 的写法读；认不出的扩展名两种都试。
 */
export function referencesFile(text, testRel, srcRel) {
  const ext = posix.extname(testRel);
  if (PY_EXT.has(ext)) return pyReferences(text, testRel, srcRel);
  if (JS_EXT.has(ext)) return jsReferences(text, testRel, srcRel);
  return jsReferences(text, testRel, srcRel) || pyReferences(text, testRel, srcRel);
}

/** 仓库里所有测试文件（已跟踪和未跟踪、未忽略），已删除的不算。 */
function listTests(root, config) {
  return git(root, ['ls-files', '--cached', '--others', '--exclude-standard'])
    .out.split('\n')
    .map((s) => s.trim().replace(/\\/g, '/'))
    .filter(Boolean)
    .filter((f) => isTestFile(f, config) && fs.existsSync(path.join(root, f)));
}

/**
 * 检查改动的源文件。changed 为本次改动文件列表；requireTestChange 为 false 时只检查“有没有测试引用”（编辑后的即时提醒用）。
 * 返回 [{ file, message }]，空数组表示通过。exempt 为豁免表中 testFirst 部分（路径 -> 理由）。
 * stats 是可选的计数输出（闸门用它报告“查了几个文件”）：checked 实际核对了测试引用的源文件数，exempt 豁免表放行的，
 * skipped 无需测试的（已删除、没有可测的导出、只有再导出的入口文件），unchecked 识别不了语言、没能检查的（文件列在 uncheckedFiles）。
 */
export function checkTestFirst({ root, changed, config, exempt = {}, requireTestChange = true, stats = {} }) {
  const problems = [];
  Object.assign(stats, { checked: 0, exempt: 0, skipped: 0, unchecked: 0, uncheckedFiles: [] });
  const testsChanged = changed.filter((f) => isTestFile(f, config));
  const tests = listTests(root, config);
  for (const src of changed.filter((f) => isSourceFile(f, config))) {
    if (exempt[src]) {
      stats.exempt++;
      continue;
    }
    const abs = path.join(root, src);
    if (!fs.existsSync(abs)) {
      stats.skipped++; // 已删除的源文件没有可检查的内容
      continue;
    }
    const ext = path.extname(src);
    if (!JS_EXT.has(ext) && !PY_EXT.has(ext)) {
      stats.unchecked++; // 不认识这种语言的引用写法，不能当作“无需测试”
      stats.uncheckedFiles.push(src);
      continue;
    }
    const text = fs.readFileSync(abs, 'utf8');
    if (!VALUE_EXPORT.test(text) || isReexportOnly(text, ext)) {
      stats.skipped++;
      continue;
    }
    stats.checked++;
    const refs = tests.filter((t) => referencesFile(fs.readFileSync(path.join(root, t), 'utf8'), t, src));
    if (refs.length === 0) {
      problems.push({ file: src, message: `${src}：没有引用它的测试（先写或补测试，再改实现）` });
    } else if (requireTestChange && !refs.some((t) => testsChanged.includes(t))) {
      problems.push({ file: src, message: `${src}：实现已改动，但引用它的测试 ${refs.join('、')} 没有随改动一起改` });
    }
  }
  return problems;
}
