// 注释检查：源文件开头要有业务职责的文件头注释（连续注释行或 Python 文档字符串）；JS/TS 的导出函数、类、常量、枚举前要有说明。
// 业务含义：注释解释意图与边界（输入输出、异常、为什么这样做），让下一个读代码的人（包括 agent）不必从实现反推业务。
// 模式 commentMode：header 只查文件头；header+exports 再查 JS/TS 导出（跳过 interface 与 type，它们不要求）。
// 局限：Python 只查文件头（文档字符串的多行内容按合并文字计）。
import fs from 'node:fs';
import path from 'node:path';

/** 注释行的开头标记（//、/*、*、#、Python 文档字符串）。 */
const COMMENT_START = /^\s*(\/\/|\/\*|\*|#|"""|''')/;
/** 需要注释的导出声明；interface、type 与 export * 不在其中。 */
const EXPORT_DECL = /^export\s+(default\s+)?(async\s+)?(function|class|const|let|var|enum)\b|^export\s*\{/;
const JS_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
/** 文件头注释的最少文字数。 */
const MIN_HEADER_CHARS = 8;

/** 去掉注释标记，只留文字。 */
function commentText(line) {
  return line
    .replace(/^\s*(\/\/+|\/\*+|\*+|#|"""|''')/, '')
    .replace(/\*\/\s*$/, '')
    .trim();
}

/**
 * 文件开头的注释文字：从第一个非空行开始，连续的注释行（或一段 Python 文档字符串，含多行）合并为一段文字。
 * 文档字符串的开闭标记不计入文字；读取上限 30 行，避免整文件被当成注释。
 */
function headerText(lines) {
  const MAX = 30;
  let text = '';
  let i = 0;
  if (lines[0]?.startsWith('#!')) i = 1; // 解释器行（#!/usr/bin/env node）不是文件头注释
  while (i < lines.length && lines[i].trim() === '') i++;
  let seen = 0;
  while (i < lines.length && seen < MAX) {
    const line = lines[i];
    const q = line.match(/^\s*("""|''')/);
    if (q) {
      const delim = q[1];
      const rest = line.trim().slice(delim.length);
      if (rest.includes(delim)) return text + rest.slice(0, rest.indexOf(delim));
      text += rest;
      i++;
      seen++;
      while (i < lines.length && seen < MAX) {
        const body = lines[i];
        if (body.includes(delim)) return text + body.slice(0, body.indexOf(delim));
        text += body;
        i++;
        seen++;
      }
      return text;
    }
    if (!COMMENT_START.test(line)) break;
    text += commentText(line);
    i++;
    seen++;
  }
  return text.trim();
}

/** 文件头注释是否足够（去掉标记后至少 8 个字）。 */
function hasHeader(lines) {
  return headerText(lines).replace(/\s+/g, '').length >= MIN_HEADER_CHARS;
}

/** 第 i 行的导出之前（跳过装饰器）是否紧挨注释行。 */
function exportHasComment(lines, i) {
  let j = i - 1;
  while (j >= 0 && lines[j].trim() === '') j--;
  while (j >= 0 && /^\s*@/.test(lines[j])) {
    j--;
    while (j >= 0 && lines[j].trim() === '') j--;
  }
  return j >= 0 && /^\s*(\/\/|\/\*|\*)/.test(lines[j]);
}

/**
 * 检查文件列表（只应传入源文件）。返回 [{ file, message }]，空数组表示通过。
 * exempt 为豁免表中 comments 部分（路径 -> 理由）。
 */
export function checkComments({ root, files, config, exempt = {} }) {
  const problems = [];
  for (const file of files) {
    if (exempt[file]) continue;
    const abs = path.join(root, file);
    if (!fs.existsSync(abs)) continue;
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    if (!hasHeader(lines)) {
      problems.push({ file, message: `${file}：缺少文件头注释（文件开头的注释说明模块的业务职责，至少 ${MIN_HEADER_CHARS} 个字）` });
    }
    if (config.commentMode !== 'header+exports' || !JS_EXT.has(path.extname(file))) continue;
    lines.forEach((line, i) => {
      if (!EXPORT_DECL.test(line)) return;
      if (!exportHasComment(lines, i)) {
        const name = (line.match(/(?:function|class|const|let|var|enum)\s+(\w+)/) || [])[1] || line.trim().slice(0, 30);
        problems.push({ file, message: `${file}:${i + 1}：导出 ${name} 前没有注释` });
      }
    });
  }
  return problems;
}
