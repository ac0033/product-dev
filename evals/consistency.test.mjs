// 技能包一致性检查：防止各技能、规则块、模板之间出现冲突、重复和过时说法。
// 业务含义：同一件事只允许有一个出处。受控的值（阶段目录、状态值、规则编号、入口）以套件配置和规则块为准，文档里出现的都必须对得上。
// 运行：在仓库根目录 node --test evals/consistency.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { HYGIENE_DEFAULTS, LAYOUT_DEFAULTS } from '../engineering-kit/kit/gate/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 不参与检查的目录：本机私有材料、工具目录；模板里的链接相对安装后的位置，单独处理。 */
const SKIP_DIRS = new Set(['.git', '.notes', '.agents', '.workbuddy', 'node_modules', 'dist']);
const TEMPLATE_DIR = 'engineering-kit/kit/templates/';

/** 递归列出仓库里的文件（相对路径，正斜杠）。 */
function listFiles(dir = ROOT, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, out);
    else out.push(path.relative(ROOT, p).replace(/\\/g, '/'));
  }
  return out;
}

const FILES = listFiles();
/** 被检查的文档：全部 Markdown，本机专用记录（*.local.md）除外。 */
const DOCS = FILES.filter((f) => f.endsWith('.md') && !f.endsWith('.local.md'));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
/** 去掉文件头元数据和代码块，避免把字段、示例命令和目录树当正文。 */
const prose = (text) => text.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/```[\s\S]*?```/g, '');

test('链接：文档里的相对链接和锚点都能到达', () => {
  const broken = [];
  for (const f of DOCS.filter((d) => !d.startsWith(TEMPLATE_DIR))) {
    for (const m of prose(read(f)).matchAll(/\]\(([^)\s]+)\)/g)) {
      const link = decodeURIComponent(m[1]);
      if (/^(https?:|mailto:|#)/.test(link)) continue;
      const [file, anchor] = link.split('#');
      const target = path.join(ROOT, path.dirname(f), file);
      if (!fs.existsSync(target)) broken.push(`${f} → ${link}`);
      else if (anchor && fs.statSync(target).isFile() && !fs.readFileSync(target, 'utf8').includes(`id="${anchor}"`)) broken.push(`${f} → ${link}（锚点不存在）`);
    }
  }
  assert.deepEqual(broken, []);
});

test('阶段目录：文档和模板里出现的阶段目录名都在套件默认配置里', () => {
  const allowed = new Set(LAYOUT_DEFAULTS.stages);
  const bad = [];
  for (const f of [...DOCS, 'engineering-kit/kit/templates/engineering.config.json']) {
    for (const m of read(f).matchAll(/0\d-[一-龥]{2,6}/g)) if (!allowed.has(m[0])) bad.push(`${f}：${m[0]}`);
  }
  assert.deepEqual([...new Set(bad)], []);
  const tpl = JSON.parse(read('engineering-kit/kit/templates/engineering.config.json'));
  assert.deepEqual(tpl.layout.stages, LAYOUT_DEFAULTS.stages, '模板配置的阶段目录与默认值不一致');
  assert.deepEqual(tpl.hygiene.statusValues, HYGIENE_DEFAULTS.statusValues, '模板配置的状态值与默认值不一致');
});

test('文档位置：设计技能约定的文档路径都在阶段目录或记录目录里', () => {
  const okPrefix = [...LAYOUT_DEFAULTS.stages.map((x) => `docs/${x}/`), ...HYGIENE_DEFAULTS.recordDirs.map((d) => `${d}/`), 'docs/_templates/'];
  const pathsIn = (f) => [...read(f).matchAll(/`(docs\/[^`\s]+)`/g)].map((m) => m[1]);
  assert.ok(pathsIn('product-design-orchestrator/references/shared-protocol.md').length >= 6, '没有从共享协议里解析到文档路径');
  const bad = [];
  for (const f of DOCS.filter((d) => /^(product-|prototype-|system-)/.test(d))) {
    for (const rel of pathsIn(f)) if (!okPrefix.some((pre) => `${rel}/`.startsWith(pre))) bad.push(`${f}：${rel}`);
  }
  assert.deepEqual(bad, []);
});

test('状态值：模板文件头的状态都在套件默认配置里', () => {
  const bad = [];
  for (const f of DOCS.filter((d) => d.startsWith(TEMPLATE_DIR))) {
    const m = read(f).match(/^状态：\s*([A-Za-z一-龥]+)/m);
    if (m && !HYGIENE_DEFAULTS.statusValues.includes(m[1])) bad.push(`${f}：${m[1]}`);
  }
  // 规则块 R5 与共享协议里列举的状态值也必须是配置里的值
  const r5 = read('engineering-kit/kit/rules/AGENTS.block.md').split('\n').find((l) => l.startsWith('- R5 '));
  const row = read('product-design-orchestrator/references/shared-protocol.md').split('\n').find((l) => l.startsWith('| 文档 |'));
  assert.ok(r5 && row, '找不到 R5 或共享协议的文档状态行');
  const listed = [];
  const r5Default = r5.match(/默认：([^）]+)）/);
  assert.ok(r5Default, 'R5 里找不到“默认：”后的状态值列表');
  for (const m of r5Default[1].matchAll(/[a-z]+/g)) listed.push(['R5', m[0]]);
  for (const m of row.matchAll(/([a-z]+)（[\u4e00-\u9fa5]+）/g)) listed.push(['共享协议', m[1]]);
  assert.ok(listed.length >= 8, '没有解析到列举的状态值');
  for (const [name, v] of listed) if (!HYGIENE_DEFAULTS.statusValues.includes(v)) bad.push(`${name}：${v}`);
  assert.deepEqual(bad, []);
});

test('规则编号：文档引用的 R 编号都在规则块里定义，且规则块编号连续不重复', () => {
  const block = read('engineering-kit/kit/rules/AGENTS.block.md');
  const defined = [...block.matchAll(/^- (R\d+) /gm)].map((m) => m[1]);
  assert.deepEqual(defined, defined.map((_, i) => `R${i + 1}`));
  const bad = [];
  for (const f of DOCS) for (const m of read(f).matchAll(/\bR(\d+)\b/g)) if (!defined.includes(`R${m[1]}`)) bad.push(`${f}：R${m[1]}`);
  assert.deepEqual([...new Set(bad)], []);
});

test('命令菜单：三个设计子技能不出现在命令菜单并写明先转总控，名称与目录一致', () => {
  const skills = FILES.filter((f) => /^[^/]+\/SKILL\.md$/.test(f));
  const hidden = [];
  for (const f of skills) {
    const fm = read(f).split('\n---\n')[0];
    assert.match(fm, new RegExp(`^name: ${f.split('/')[0]}$`, 'm'), `${f} 的 name 与目录不一致`);
    if (/^user-invocable: false$/m.test(fm)) {
      hidden.push(f.split('/')[0]);
      assert.ok(read(f).includes('被直接加载时，先加载总控'), `${f} 没有写明被直接加载时先转总控`);
    }
  }
  assert.deepEqual(hidden.sort(), ['product-discovery-prd', 'prototype-design', 'system-architecture-design']);
});

test('已废弃的说法：不再出现在任何文档里', () => {
  // 每条对应 conflict-matrix.md 的一项裁决；该文件本身要引用旧说法，不检查。
  const banned = ['docs/design/', '单阶段任务可直接使用对应技能', '使用对应子技能', '单独调用子技能', '草稿、评审中、基线、已取代', '删除文件须先列清单'];
  const bad = [];
  const scripts = FILES.filter((f) => /^engineering-kit\/kit\/(gate|hooks|tools)\/.*\.(mjs|sh)$/.test(f));
  for (const f of [...DOCS.filter((d) => d !== 'evals/conflict-matrix.md'), ...scripts]) for (const b of banned) if (read(f).includes(b)) bad.push(`${f}：${b}`);
  assert.deepEqual(bad, []);
});

test('重复：同一句较长的话不出现在两个文件里', () => {
  const seen = new Map();
  for (const f of DOCS.filter((d) => !d.startsWith(TEMPLATE_DIR) && d !== 'evals/conflict-matrix.md')) {
    for (const raw of prose(read(f)).split('\n')) {
      // 标题、命令行不算正文句子；表格按单元格拆开一起查
      if (/^\s*(#|```|- \[)/.test(raw) || raw.includes('`node ')) continue;
      for (const sent of raw.split(/[。；|]/)) {
        const key = sent.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[\s*`>\-0-9.、，：]/g, '');
        // 至少 16 个字符且含 8 个以上汉字才算一句话（排除只有技能名、路径的单元格）
        if (key.length < 16 || (key.match(/[一-龥]/g) || []).length < 8) continue;
        const files = seen.get(key) || new Set();
        files.add(f);
        seen.set(key, files);
      }
    }
  }
  const dup = [...seen].filter(([, files]) => files.size > 1).map(([k, files]) => `${[...files].join(' = ')}：${k.slice(0, 40)}`);
  assert.deepEqual(dup, []);
});
