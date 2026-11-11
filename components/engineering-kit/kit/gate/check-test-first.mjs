// 测试先行检查：改动的每个源文件都要有引用它的测试；有实现改动时，引用它的测试也必须在本次改动里。
// 业务含义：防止“只写实现、不写测试”，或“改了实现、测试没跟着变”。
// 判断依据：测试文件里是否有 import / require / from 语句指向该源文件的模块名（文件名去掉扩展名）。
// 局限：经 index 等再导出的间接引用不被识别，应在豁免表里写理由。
import fs from 'node:fs';
import path from 'node:path';
import { git, isSourceFile, isTestFile } from './lib.mjs';

/** 只有类型或只有再导出的文件不要求测试（它们没有可测的行为）。 */
const VALUE_EXPORT = /\bexport\b|^\s*(def|class)\s/m;
/** 入口与再导出文件的名字：这些文件的行为由它们导入的模块测试覆盖。 */
const SKIP_NAMES = new Set(['index', '__init__', 'mod']);

/** 转义正则特殊字符，使模块名可以安全地放进正则。 */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 测试文本里是否有 import/require/from 语句引用了名为 name 的模块（JS/TS 与 Python 两种写法）。 */
export function referencesModule(text, name) {
  const n = escapeRe(name);
  const js = new RegExp(`(?:from|import|require\\(|import\\s*\\()\\s*['"\`][^'"\`\\n]*\\b${n}(?:\\.\\w+)?['"\`]`, 'm');
  // Python：import pkg.name、from pkg.name import x，以及 from pkg import name（模块作为包的成员导入）
  const py = new RegExp(`^\\s*(?:from|import)\\s+[\\w.]*\\b${n}\\b`, 'm');
  const pyMember = new RegExp(`^\\s*from\\s+[\\w.]+\\s+import\\s+[^\\n#]*\\b${n}\\b`, 'm');
  return js.test(text) || py.test(text) || pyMember.test(text);
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
 * skipped 无需测试的（已删除、没有可测的导出、入口与再导出文件）。
 */
export function checkTestFirst({ root, changed, config, exempt = {}, requireTestChange = true, stats = {} }) {
  const problems = [];
  Object.assign(stats, { checked: 0, exempt: 0, skipped: 0 });
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
    const text = fs.readFileSync(abs, 'utf8');
    const name = path.basename(src, path.extname(src));
    if (!VALUE_EXPORT.test(text) || SKIP_NAMES.has(name)) {
      stats.skipped++;
      continue;
    }
    stats.checked++;
    const refs = tests.filter((t) => referencesModule(fs.readFileSync(path.join(root, t), 'utf8'), name));
    if (refs.length === 0) {
      problems.push({ file: src, message: `${src}：没有引用它的测试（先写或补测试，再改实现）` });
    } else if (requireTestChange && !refs.some((t) => testsChanged.includes(t))) {
      problems.push({ file: src, message: `${src}：实现已改动，但引用它的测试 ${refs.join('、')} 没有随改动一起改` });
    }
  }
  return problems;
}
