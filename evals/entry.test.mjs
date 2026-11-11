// 综合插件入口技能的检查。
// 业务含义：入口是用户唯一接触的部分。流程导图里的每个步骤都必须在入口里，并且目标、原则、工具、过关证据四栏齐全；
// 每一步写的工具必须是插件里真实存在的文件、子代理或脚本，不能指向只存在于某个宿主或没有收录的东西。
// 运行：在仓库根目录 node --test evals/entry.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, LAYOUT_DEFAULTS } from '../components/engineering-kit/kit/gate/config.mjs';
import { ENTRY_SKILL, PLUGIN_DIR, ROOT } from '../tools/build-plugin.mjs';

const PLUGIN = path.join(ROOT, PLUGIN_DIR);
const ENTRY_DIR = `skills/${ENTRY_SKILL}`;
const REFS = ['process', 'planning', 'build', 'self-review', 'review', 'debugging'];
/** 插件内的相对路径是否存在。 */
const has = (rel) => fs.existsSync(path.join(PLUGIN, rel));
const read = (rel) => fs.readFileSync(path.join(PLUGIN, rel), 'utf8').replace(/\r\n/g, '\n');
const ENTRY = read(`${ENTRY_DIR}/SKILL.md`);

/**
 * 流程导图里的步骤清单（来源：流程导图的四张流程图，共 31 步；2026-11-12 起交付段在任务拆解与逐片开发之间加了“测试设计”，
 * 共 32 步，docs/images/delivery.png 还没重画）。键是入口里的节标题开头。导图改了步骤，这里和入口要一起改。
 */
export const STEPS = {
  '0. 恢复现场': ['恢复现场'],
  '2. 新项目': ['装工程底座', '需求 PRD', '原型与 UI', '实际走查', '架构设计', '综合评审', '配置闸门'],
  '3. 加功能': ['开工检查', '探索代码库', '澄清问题', '改产品行为?', '功能契约', '方案对比', '用户选定方案'],
  '4. 交付段': ['任务拆解', '测试设计', '逐片开发', '推送前自查', '机械闸门', 'PR 与 CI', '独立复审', '合并与收工', '验收与发布'],
  '5. 修 bug': ['稳定复现', '定位根因', '是需求缺口?', '写失败测试', '最小修复', '查同类与调用方', '自查到合并', '回归入库'],
};
/**
 * 各步的目标，照流程导图抄录。入口里的“目标”栏必须与这里逐字相同：改弱、改错都会被查出来。
 * 导图改了目标，这里和入口一起改。
 */
export const GOALS = {
  "恢复现场": "确认目标项目和已有成果，从实际缺口续做",
  "装工程底座": "装好规则、钩子、阶段目录和文档模板，设计文档从第一天就落在规定位置",
  "需求 PRD": "得到用户确认的 PRD 版本，每项需求有 ID 和验收标准",
  "原型与 UI": "产出信息架构、核心路径和可操作原型",
  "实际走查": "留下走查证据，取得用户认可的体验基线",
  "架构设计": "给出两张核心图、关键机制和 ADR",
  "综合评审": "判定实施准备度，交出实施计划和追踪矩阵",
  "配置闸门": "按选定的技术栈填好测试命令和源码、测试文件的匹配规则",
  "开工检查": "从最新主干开分支，确认没有遗留的未提交改动",
  "探索代码库": "找出相似功能、相关模块和必读文件清单",
  "澄清问题": "边界情况、错误处理、兼容性都有明确答案",
  "改产品行为?": "判断这次改动要不要先改 PRD 和原型",
  "功能契约": "写清“怎样证明做对了”，取得用户确认",
  "方案对比": "比较最小改动、结构清晰、折中三种做法并给出推荐",
  "用户选定方案": "得到明确批准再进入交付段",
  "任务拆解": "拆成纵向切片，每片有验收条件和验证方法",
  "测试设计": "依据契约或 PRD 的场景表先写出测试，预期不从实现倒推",
  "逐片开发": "每片先写测试、再实现、通过后提交",
  "推送前自查": "作者一侧的问题清零",
  "机械闸门": "静态检查、测试记录都与当前代码一致",
  "PR 与 CI": "PR 最终提交上的必需检查全部通过",
  "独立复审": "代码复审和一致性审的结论绑定 PR 最终提交",
  "合并与收工": "经合并入口合并，删除分支和工作树，清理临时文件",
  "验收与发布": "预发验证、用户验收、灰度上线各留证据",
  "稳定复现": "拿到能重复触发的步骤和实际输出",
  "定位根因": "说清哪一行、哪个条件导致了错误",
  "是需求缺口?": "分清“实现错了”还是“需求没写”",
  "写失败测试": "有一个现在失败、修好后通过的测试",
  "最小修复": "在共用代码里修一次，测试转绿",
  "查同类与调用方": "确认同一个函数的其他调用方没有被改坏",
  "自查到合并": "走完交付段的自查、闸门、CI、独立复审和合并",
  "回归入库": "失败测试留在测试集里；线上事故另查为何漏检",
};
const COLUMNS = ['步骤', '目标', '原则', '工具', '过关证据'];

/** 把入口按二级标题切成节，取出每节里表头为“步骤、目标、原则、工具、过关证据”的表格行。 */
export function stepRows(text) {
  const out = new Map();
  for (const section of text.split(/^## /m).slice(1)) {
    const title = section.split('\n')[0].trim();
    const lines = section.split('\n');
    const head = lines.findIndex((l) => l.replace(/\s/g, '') === `|${COLUMNS.join('|')}|`);
    if (head < 0) continue;
    const rows = [];
    for (const line of lines.slice(head + 2)) {
      if (!line.startsWith('|')) break;
      rows.push(line.slice(1, line.lastIndexOf('|')).split('|').map((c) => c.trim()));
    }
    out.set(title, rows);
  }
  return out;
}

/**
 * 一段文字里“能在插件里核对”的工具引用，返回 [{ ref, target }]，target 是它在插件里应当存在的相对路径。
 * 认五种写法：相对链接、product-dev:<名>（内部技能或子代理）、<插件根>/ 路径、
 * 装进项目后的闸门脚本 scripts/engineering/gate/*、装进项目后的模板 docs/_templates/*。
 */
export function toolRefs(text) {
  const refs = [];
  for (const m of text.matchAll(/\]\(([^)\s#]+)(#[^)\s]*)?\)/g)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(m[1])) continue;
    refs.push({ ref: m[1], target: path.posix.normalize(path.posix.join(ENTRY_DIR, m[1])) });
  }
  for (const m of text.matchAll(/product-dev:([a-z][a-z0-9-]*)/g)) {
    const target = [`agents/${m[1]}.md`, `skills/${m[1]}/SKILL.md`].find(has) || `agents/${m[1]}.md`;
    refs.push({ ref: m[0], target });
  }
  for (const m of text.matchAll(/<插件根>\/([\w./-]+)/g)) refs.push({ ref: m[0], target: m[1].replace(/\/$/, '') });
  for (const m of text.matchAll(/scripts\/engineering\/gate\/([\w-]+\.mjs)/g)) refs.push({ ref: m[0], target: `skills/engineering-kit/kit/gate/${m[1]}` });
  for (const m of text.matchAll(/docs\/_templates\/([\w-]+\.md)/g)) refs.push({ ref: m[0], target: `skills/engineering-kit/kit/templates/docs/templates/${m[1]}` });
  return refs;
}

test('步骤齐全：导图里的步骤入口里都有，次序一致，四栏都写了内容', () => {
  const rows = stepRows(ENTRY);
  let count = 0;
  for (const [prefix, names] of Object.entries(STEPS)) {
    const title = [...rows.keys()].find((t) => t.startsWith(prefix));
    assert.ok(title, `入口里没有“${prefix}”一节的步骤表`);
    assert.deepEqual(rows.get(title).map((r) => r[0]), names, `“${title}”的步骤与导图不一致`);
    for (const cells of rows.get(title)) {
      assert.equal(cells.length, COLUMNS.length, `${cells[0]} 的栏数不是 ${COLUMNS.length}`);
      assert.equal(cells[1], GOALS[cells[0]], `${cells[0]} 的目标与导图不一致`);
      cells.forEach((c, i) => assert.ok(c.replace(/[\s—\-–]/g, '').length >= 4, `${cells[0]} 的“${COLUMNS[i]}”一栏是空的`));
      count += 1;
    }
  }
  assert.equal(count, 32, '步骤总数不是 32 步（导图的 31 步加测试设计）');
  assert.equal([...rows.keys()].length, Object.keys(STEPS).length, '入口里有清单之外的步骤表');
});

test('工具落地：每一步的工具都指向插件里存在的文件、子代理或脚本', () => {
  const missing = [];
  const ungrounded = [];
  for (const rows of stepRows(ENTRY).values()) {
    for (const cells of rows) {
      const refs = toolRefs(cells[3]);
      if (!refs.length) ungrounded.push(cells[0]);
      for (const { ref, target } of refs) if (!has(target)) missing.push(`${cells[0]}：${ref} → ${target}`);
      // 只有 Claude Code 才有的内置命令不能写进步骤的工具栏
      assert.doesNotMatch(cells[3], /\/(simplify|code-review|security-review)\b/, `${cells[0]} 的工具栏用了只有 Claude Code 才有的命令`);
    }
  }
  assert.deepEqual(ungrounded, [], '这些步骤的工具栏没有一个能在插件里核对的部件');
  assert.deepEqual(missing, []);
  // 步骤表之外（约定、分流、缩短路线等）提到的部件同样要存在
  assert.deepEqual(toolRefs(ENTRY).filter((r) => !has(r.target)).map((r) => `${r.ref} → ${r.target}`), []);
  assert.ok(toolRefs(ENTRY).length >= 60, '没有从入口里解析到工具引用');
});

test('工具落地：入口点名的方法文档小节和步骤号都存在，六份方法文档都被入口用到', () => {
  const bad = [];
  // 例：[process.md](references/process.md) 的“开工”、[process.md](references/process.md)“收工”
  for (const m of ENTRY.matchAll(/\]\(references\/([\w-]+)\.md\)[^“|\n]{0,3}“([^”]+)”/g)) {
    const headings = read(`${ENTRY_DIR}/references/${m[1]}.md`).split('\n').filter((l) => /^#{2,3} /.test(l)).map((l) => l.replace(/^#+ (\d+\. )?/, ''));
    if (!headings.includes(m[2])) bad.push(`${m[1]}.md 没有“${m[2]}”这一节`);
  }
  for (const m of ENTRY.matchAll(/\]\(references\/debugging\.md\) 第 ([\d、]+) 步/g)) {
    for (const n of m[1].split('、')) if (!read(`${ENTRY_DIR}/references/debugging.md`).includes(`### 第 ${n} 步`)) bad.push(`debugging.md 没有第 ${n} 步`);
  }
  assert.deepEqual(bad, []);
  assert.ok([...ENTRY.matchAll(/\]\(references\/[\w-]+\.md\)[^“|\n]{0,3}“/g)].length >= 8, '没有解析到对方法文档小节的引用');
  const steps = [...stepRows(ENTRY).values()].flat().map((c) => c[3]).join('\n');
  for (const name of REFS) assert.ok(steps.includes(`(references/${name}.md)`), `没有哪一步用到 ${name}.md`);
  assert.deepEqual(fs.readdirSync(path.join(PLUGIN, ENTRY_DIR, 'references')).sort(), REFS.map((n) => `${n}.md`).sort());
});

test('授权口径：分流和装工程底座写明受 R2 约束，可选加强单列，纪律不复述规则原文', () => {
  const line = (key) => ENTRY.split('\n').find((l) => l.includes(key)) || '';
  assert.match(line('先说判断'), /R2/, '分流的“先说判断”没有写明按 R2');
  for (const key of ['可以直接做', '先得到批准']) assert.ok(line(key), `分流没有写“${key}”`);
  assert.match(line('装工程底座的授权'), /R2/);
  assert.match(line('装工程底座的授权'), /R6/, '装工程底座没有写明在项目根之外新建目录按 R6');
  assert.ok(!/不等确认|直接开始，不/.test(ENTRY), '入口里还有不受 R2 约束的“直接开始”');
  // 内置命令只出现在“可选加强”一条里
  const builtin = ENTRY.split('\n').filter((l) => /`\/(simplify|code-review|security-review)`/.test(l));
  assert.equal(builtin.length, 1);
  assert.match(builtin[0], /可选加强.*不能代替/);
  // R2 原文里的整句不应出现在入口里（只引用编号）
  const r2 = read('skills/engineering-kit/kit/rules/AGENTS.block.md').split('\n').find((l) => l.startsWith('- R2 '));
  for (const sent of r2.split(/[。；]/).map((s) => s.trim()).filter((s) => s.length >= 20)) assert.ok(!ENTRY.includes(sent), `入口复述了 R2 的原文：${sent.slice(0, 20)}`);
  assert.match(ENTRY, /## 用户授权“按推荐执行”后怎么推进/);
});

test('受控的值：方法文档里的默认值与套件配置一致，常规动作一句没有丢', () => {
  const review = read(`${ENTRY_DIR}/references/review.md`);
  const proc = read(`${ENTRY_DIR}/references/process.md`);
  assert.ok(review.includes(`默认 ${DEFAULTS.reviewMinChars}`), '复审报告最短字数与套件默认值不一致');
  assert.ok(review.includes(`不少于 ${DEFAULTS.reviewMinChars} 字`), '任务书里的最短字数与套件默认值不一致');
  assert.ok(review.includes(`默认是“${DEFAULTS.reviewKeyword}”`) && review.includes(`## ${DEFAULTS.reviewKeyword}`), '报告格式里没有套件要求的关键词一节');
  for (const name of DEFAULTS.reviewers) assert.ok(review.includes(`\`${name}\``), `review.md 没有列出默认复审者 ${name}`);
  assert.ok(proc.includes(`\`${DEFAULTS.reviewFlow}\`（默认）`), '默认复审流程与套件默认值不一致');
  for (const stage of LAYOUT_DEFAULTS.stages) assert.ok(proc.includes(`\`${stage}\``), `process.md 的阶段目录缺 ${stage}`);
  assert.ok(proc.includes('推送功能分支、合并（经合并入口）、构建、预发部署属于常规动作'));
  for (const cmd of ['review.mjs pass|fail --reviewer', '--kind code', '--kind consistency', 'review.mjs defer --pr', 'merge.mjs <编号>']) assert.ok(proc.includes(cmd), `process.md 缺复审流程的命令：${cmd}`);
});

test('出处：改写的方法文档文末注明来源，第三方声明、组件清单、README 与之相符', () => {
  const notices = read('THIRD_PARTY_NOTICES.md');
  const components = fs.readFileSync(path.join(ROOT, 'COMPONENTS.md'), 'utf8');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const sources = {
    ponytail: { url: 'https://github.com/DietrichGebert/ponytail', copyright: 'Copyright (c) 2026 DietrichGebert', docs: ['build', 'self-review'] },
    'agent-skills': { url: 'https://github.com/addyosmani/agent-skills', copyright: 'Copyright (c) 2025 Addy Osmani', docs: ['planning', 'build', 'debugging', 'review'] },
  };
  assert.ok(readme.includes('(COMPONENTS.md)') && readme.includes('(plugin/THIRD_PARTY_NOTICES.md)'), 'README 应链接组件版本清单与第三方声明');
  for (const [name, s] of Object.entries(sources)) {
    const section = notices.split(/^## /m).find((x) => new RegExp(`^\\d+\\. ${name}$`).test(x.split('\n')[0]));
    assert.ok(section, `第三方声明里没有 ${name} 一节`);
    const row = components.split('\n').find((l) => l.startsWith(`| ${name} |`));
    assert.ok(row, `COMPONENTS.md 里没有 ${name}`);
    const version = row.split('|')[3].trim().split('（')[0];
    for (const text of [s.url, `版本：${version}`, '原许可：MIT', s.copyright, '我们的改动：']) assert.ok(section.includes(text), `第三方声明的 ${name} 一节缺：${text}`);
    assert.ok(row.includes('已收录（翻译和改写）'), `COMPONENTS.md 里 ${name} 没有标为已收录`);
    for (const doc of s.docs) {
      const tail = read(`${ENTRY_DIR}/references/${doc}.md`).split('\n---\n').pop();
      for (const text of ['出处：', s.url, version, 'MIT 许可', s.copyright, '改动：', 'THIRD_PARTY_NOTICES.md']) assert.ok(tail.includes(text), `${doc}.md 文末的出处缺：${text}`);
      assert.ok(section.includes(`references/${doc}.md`), `第三方声明的 ${name} 一节没有列 ${doc}.md`);
    }
  }
  const version = JSON.parse(read('.claude-plugin/plugin.json')).version;
  assert.ok(components.includes(`${version}：`) && readme.includes(`（${version}）`), `COMPONENTS.md 或 README 里的插件版本不是 ${version}`);
  assert.ok(!/存放在维护者本机|计划：/.test(components), 'COMPONENTS.md 还留着旧说法');
  assert.ok(!notices.includes('不是逐句翻译') && notices.includes('接近原文的逐句翻译'), '第三方声明对改写程度的说明不如实');
});

// ---- 以下几项针对语义层面的走样：分流的实质内容、缩短路线、两种复审流程的次序、命令参数、章节引用、原文保留 ----

const DOCS = [`${ENTRY_DIR}/SKILL.md`, ...REFS.map((n) => `${ENTRY_DIR}/references/${n}.md`)];
/** 与重复检查相同的归一化：去掉链接地址、空白、标点和数字，只比文字。 */
const norm = (s) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[\s*`>\-0-9.、，：]/g, '');
/** 把一段文字拆成归一化后的句子，只留够长、含 8 个以上汉字的。 */
const sentences = (text) => text.replace(/```[\s\S]*?```/g, '').split('\n').filter((l) => !/^\s*#/.test(l)).flatMap((l) => l.split(/[。；|]/)).map(norm).filter((k) => k.length >= 16 && (k.match(/[一-龥]/g) || []).length >= 8);

test('分流与次序：授权的实质句子、缩短路线的步骤、两种复审流程的次序都没有走样', () => {
  const line = (key) => ENTRY.split('\n').find((l) => l.includes(key)) || '';
  // 这几句决定 agent 会不会未经批准动手，逐字钉住
  assert.ok(line('先得到批准：').includes('只做只读的事，说明判断和打算怎么做，得到批准后才改文件、提交或安装'), '“先得到批准”一条被改了');
  assert.ok(line('先得到批准：').includes('新提出的描述或问句不因它变成要求'), '没有写明按推荐执行的授权不覆盖新提出的问句');
  assert.ok(line('可以直接做：').includes('不改文件也不切换检出的复现'), '只读的范围没有限定为不改文件的复现');
  assert.ok(!/或已授权按推荐执行时，说完判断/.test(ENTRY), '按推荐执行又被扩成了“问句也可以开工”');
  assert.ok(line('第一个会改文件或切换检出的动作').includes('先按第 1 节得到批准'), '修 bug 没有写明改文件前先得到批准');
  assert.ok(line('实际安装、升级、回滚').includes('先得到用户批准（R2）'), '装或升级套件没有写明先得到批准');
  assert.ok(line('装工程底座的授权').includes('用户只是在描述想法或提问时，先得到批准再装，已授权按推荐执行也不例外'), '装工程底座的授权被放宽了');
  assert.ok(!/或已授权按推荐执行时[^。；]*(直接|开始)/.test(ENTRY), '又出现了“已授权按推荐执行就可以直接做”的写法');
  assert.ok(line('远程仓库与合并入口').includes('由用户合并或由用户指定入口，不自行合并'), '没有写明 pre-push 流程下不自行合并');
  assert.ok(line('始终单独授权的事项').includes('按 R2 的清单办，不因路线已开始而省略'), '“始终单独授权”一条被改了');
  // 分流表：六种情况各自的路线
  const routes = { 新项目: '第 2 节（装工程底座 → 设计段 → 配置闸门）→ 第 4 节', 加功能: '第 3 节 → 第 4 节', 小新增: '第 6 节', '修 bug': '第 5 节', 小改动: '第 6 节', 只改文档: '第 6 节', 装或升级工程套件: '第 7 节' };
  const routing = ENTRY.split(/^## /m).find((s) => s.startsWith('1. 分流'));
  for (const [kind, route] of Object.entries(routes)) {
    const row = routing.split('\n').find((l) => l.startsWith(`| ${kind} |`));
    assert.ok(row, `分流表里没有“${kind}”`);
    assert.equal(row.split('|')[3].trim(), route, `“${kind}”的路线走样了`);
  }
  assert.ok(line('建远程仓库是外部动作').includes('先得到用户批准'), '建远程仓库没有写明先得到批准');
  // 缩短路线：步骤序列固定，其中每一步都是流程里有的步骤
  const all = new Set(Object.values(STEPS).flat());
  const short = { 小新增: ['开工检查', '读相关代码', '逐片开发', '推送前自查', '机械闸门', 'PR 与 CI', '独立复审', '合并与收工'], 小改动: ['开工检查', '逐片开发', '推送前自查', '机械闸门', 'PR 与 CI', '独立复审', '合并与收工'], 只改文档: ['开工检查', '直接改', '机械闸门', 'PR 与 CI', '合并与收工'] };
  for (const [route, expected] of Object.entries(short)) {
    const row = ENTRY.split('\n').find((l) => l.startsWith(`| ${route} |`) && l.includes('→'));
    assert.ok(row, `缩短路线里没有“${route}”`);
    const steps = row.split('|')[2].split('→').map((s) => s.replace(/（[^）]*）/g, '').trim());
    assert.deepEqual(steps, expected, `“${route}”的步骤走样了`);
    for (const s of steps) assert.ok(all.has(s) || ['直接改', '读相关代码'].includes(s),`“${route}”里的 ${s} 不是流程里的步骤`);
  }
  assert.match(line('| 只改文档 | 开工检查'), /不做独立复审（R7）/);
  // 两种复审流程的次序
  assert.ok(ENTRY.includes('独立复审排在机械闸门之后、推送之前'), '入口没有写对 pre-push 流程的次序');
  assert.ok(ENTRY.includes('小改动的独立复审排在闸门之后、推送之前'), '缩短路线没有写对 pre-push 流程的次序');
  const proc = read(`${ENTRY_DIR}/references/process.md`);
  assert.ok(proc.includes('`gate.mjs` 通过后由独立子代理复审') && proc.includes('`gate.mjs` 通过后即可推送'), 'process.md 里两种流程的次序走样了');
});

test('命令参数：文档里给脚本写的参数，脚本里都有', () => {
  const bad = [];
  let count = 0;
  for (const doc of DOCS) {
    for (const span of read(doc).match(/`[^`\n]*\b(sync|gate|review|merge|hygiene|verify)\.mjs[^`\n]*`/g) || []) {
      const script = span.match(/\b(sync|gate|review|merge|hygiene|verify)\.mjs/)[1];
      let src = read(script === 'sync' ? 'skills/engineering-kit/kit/sync.mjs' : `skills/engineering-kit/kit/gate/${script}.mjs`);
      // sync.mjs 内部还调用 git，全文里有别的命令的参数；只看它自己的参数解析函数
      if (script === 'sync') src = src.slice(src.indexOf('function parseArgs'), src.indexOf('\n}\n', src.indexOf('function parseArgs')));
      for (const flag of span.match(/--[a-z][a-z-]*/g) || []) {
        count += 1;
        // 脚本里出现过这个参数（解析代码或用法说明）才算有
        if (!new RegExp(`${flag}(?![a-z-])`).test(src)) bad.push(`${doc}：${script}.mjs 没有参数 ${flag}`);
      }
    }
  }
  assert.deepEqual(bad, []);
  assert.ok(count >= 12, `只解析到 ${count} 个命令参数`);
});

test('章节引用：各文档点名的小节、“第 N 节”和子代理名都存在', () => {
  const bad = [];
  let count = 0;
  const headings = (rel) => read(rel).split('\n').filter((l) => /^#{2,3} /.test(l)).map((l) => l.replace(/^#+ /, ''));
  for (const doc of DOCS) {
    const text = read(doc);
    const resolve = (link) => path.posix.normalize(path.posix.join(path.posix.dirname(doc), link));
    // [x.md](链接) 的“小节”
    for (const m of text.matchAll(/\]\(([^)\s#]+\.md)\)[^“|\n]{0,3}“([^”]+)”/g)) {
      count += 1;
      if (!headings(resolve(m[1])).some((h) => h.replace(/^\d+\. /, '') === m[2])) bad.push(`${doc}：${m[1]} 没有“${m[2]}”这一节`);
    }
    // [x](链接) 第 N 节、第 N 到 M 节、第 N、M 节
    for (const m of text.matchAll(/\]\(([^)\s#]+\.md)\)[^|\n，。；]{0,8}?第 (\d+)(?:(?: 到 |、)(\d+))? 节/g)) {
      for (const n of [m[2], m[3]].filter(Boolean)) {
        count += 1;
        if (!headings(resolve(m[1])).some((h) => h.startsWith(`${n}. `))) bad.push(`${doc}：${m[1]} 没有第 ${n} 节`);
      }
    }
    // 同一文件里的“第 N 节”（review.md 的任务书和正文互相引用）
    if (doc.endsWith('/review.md')) {
      for (const m of text.matchAll(/第 (\d+)(?:、(\d+))?(?:、(\d+))? 节/g)) {
        for (const n of m.slice(1).filter(Boolean)) {
          count += 1;
          if (!headings(doc).some((h) => h.startsWith(`${n}. `))) bad.push(`${doc}：没有第 ${n} 节`);
        }
      }
    }
    for (const m of text.matchAll(/product-dev:([a-z][a-z0-9-]*)/g)) if (![`agents/${m[1]}.md`, `skills/${m[1]}/SKILL.md`].some(has)) bad.push(`${doc}：没有 ${m[0]}`);
  }
  assert.deepEqual(bad, []);
  assert.ok(count >= 25, `只解析到 ${count} 处章节引用`);
});

test('不复述规则：入口和方法文档里没有 R1–R10 的原句', () => {
  const rules = read('skills/engineering-kit/kit/rules/AGENTS.block.md').split('\n').filter((l) => /^- R\d+ /.test(l));
  assert.equal(rules.length, 10);
  const bad = [];
  for (const doc of DOCS) {
    const text = norm(read(doc));
    for (const rule of rules) for (const s of sentences(rule.replace(/^- R\d+ [^：]*：/, ''))) if (text.includes(s)) bad.push(`${doc} 复述了 ${rule.slice(2, 5).trim()}：${s.slice(0, 24)}`);
  }
  assert.deepEqual(bad, []);
});

test('原文保留：process.md 由套件流程文档重组而来，各节的句子大多数还在', () => {
  // 局限：只比句子是否原样保留。个别句子因章节号、文件位置不同而改写是正常的，所以按比例判断；
  // 少量句子被删或被改弱查不出来，靠独立复审。套件那份改了而这里没跟着改时，比例下降，同样会报出来。
  const original = fs.readFileSync(path.join(ROOT, 'components/engineering-kit/references/process.md'), 'utf8').replace(/\r\n/g, '\n');
  const mine = norm(read(`${ENTRY_DIR}/references/process.md`));
  let total = 0;
  let kept = 0;
  const low = [];
  for (const section of original.split(/^## /m).slice(1)) {
    const title = section.split('\n')[0];
    const all = sentences(section.slice(title.length));
    const here = all.filter((s) => mine.includes(s)).length;
    total += all.length;
    kept += here;
    // 每节最多缺三成；句子少的节至少容许缺两句
    if (all.length - here > Math.max(2, all.length * 0.3)) low.push(`${title}：${here}/${all.length}`);
  }
  assert.ok(total >= 100, '没有从套件流程文档里解析到句子');
  assert.deepEqual(low, [], '这些节缺的句子太多');
  assert.ok(kept / total >= 0.8, `整体只保留了 ${kept}/${total}`);
});

test('第三方版本：声明里的提交号与组件清单一致', () => {
  const notices = read('THIRD_PARTY_NOTICES.md');
  const components = fs.readFileSync(path.join(ROOT, 'COMPONENTS.md'), 'utf8');
  for (const name of ['ponytail', 'agent-skills']) {
    const commit = components.split('\n').find((l) => l.startsWith(`| ${name} |`)).match(/提交 ([0-9a-f]{7,})/);
    assert.ok(commit, `COMPONENTS.md 里 ${name} 没有提交号`);
    const section = notices.split(/^## /m).find((x) => new RegExp(`^\\d+\\. ${name}$`).test(x.split('\n')[0]));
    assert.ok(section.includes(`提交 ${commit[1]}`), `第三方声明里 ${name} 的提交号不是 ${commit[1]}`);
  }
});

test('设计角色的兼任与模型：规则只写在设计总控第 1 节，入口引用它、不另写一套', () => {
  const orch = read('skills/product-design-orchestrator/SKILL.md');
  const sec1 = orch.split(/^## /m).find((s) => s.startsWith('1. '));
  // 用户 2026-11-11 定的规则（含当天补充的“专业修订先确认再兼任”），逐句钉住
  for (const text of [
    '只有“修订一个角色的一份已有产物”时，主对话才可以兼任该角色',
    '新建产物，或一次改动涉及两个以上角色的，另开角色上下文，不兼任',
    '直接兼任：对上下文影响不大、要求不高、不需要专门技能或工具的修订',
    '先向用户确认再兼任：不属于上一种的修订都算这一种，典型的是要用到该角色的专业方法或专门工具的',
    '兼任前先加载该角色的技能，改完在汇报里写明这次是主对话兼任的',
    '已授权按推荐执行（R2）时，这一种不按授权直接兼任，另开角色上下文',
    '拿不准算哪一种时另开',
    '需求角色和架构角色用不弱于主对话的模型',
    '原型角色可以用中档模型',
  ]) assert.ok(sec1.includes(text), `设计总控第 1 节缺：${text}`);
  // 入口：指向总控第 1 节，自己不定义兼任条件和角色的模型档位
  const pointers = ENTRY.split('\n').filter((l) => l.includes('兼任'));
  assert.ok(pointers.length >= 1 && pointers.every((l) => /总控.{0,60}第 1 节/.test(l)), '入口提到兼任的地方没有指向设计总控第 1 节');
  for (const banned of ['一份已有产物', '两个以上角色', '直接兼任', '确认再兼任', '原型角色可以用', '需求角色和架构角色用']) assert.ok(!ENTRY.includes(banned), `入口重复定义了设计总控的规则：${banned}`);
  // 入口里别的说法不能与总控矛盾：不能再写“不直接加载角色技能”这种一刀切的话
  assert.ok(!ENTRY.includes('；不直接加载角色技能。'), '入口仍写着主对话一律不加载角色技能，与兼任规则矛盾');
});

test('模型分档、测试阶段与复审循环：R9 写明分档，入口和方法文档只引用它；两份任务书、报告落盘、四个测试阶段都在', () => {
  const r9 = read('skills/engineering-kit/kit/rules/AGENTS.block.md').split('\n').find((l) => l.startsWith('- R9 '));
  for (const text of ['测试设计不低于实施者', '首轮代码复审、安全专项', '一致性审和范围明确的修后复核可以用中档模型', '升档重审', '优先用脚本']) assert.ok(r9.includes(text), `R9 缺：${text}`);
  assert.ok(!r9.includes('复审模型不弱于被复审内容的作者'), 'R9 还是不分档的旧说法');
  const review = read(`${ENTRY_DIR}/references/review.md`);
  const proc = read(`${ENTRY_DIR}/references/process.md`);
  assert.ok(ENTRY.includes('测试设计和各种复审按 R9 的分档') && !ENTRY.includes('方案设计和复审用不弱于主对话的模型'), '入口“约定”的模型一句没有改成引用 R9 的分档');
  assert.ok(review.includes('模型：按 R9 的分档') && !review.includes('复审用的模型不弱于被复审内容的作者'), 'review.md 第 1 节的模型一段没有改成按 R9 分档');
  for (const h of ['### 首轮任务书', '### 修后复核任务书', '## 8. 一轮与修复循环']) assert.ok(review.includes(h), `review.md 缺“${h}”`);
  for (const text of ['以本任务书为准', '不按置信度过滤', '不是未暂存的改动', '报告一律由主对话落盘', '已关闭', '反转验证']) assert.ok(review.includes(text), `review.md 缺：${text}`);
  assert.ok(!review.includes('能写文件的把报告写到'), 'review.md 还在区分复审者能不能写文件');
  for (const cmd of ['accept', '--user-decision', '--kind consistency', 'defer --kind consistency']) assert.ok(review.includes(cmd), `review.md 缺 ${cmd}`);
  const phases = proc.split('### 测试的四个阶段')[1]?.split(/^##+ /m)[0] ?? '';
  for (const row of ['| 开发中 |', '| 首次候选 |', '| 修复后 |', '| 最终提交 |']) assert.ok(phases.includes(row), `process.md 的测试阶段缺 ${row}`);
  assert.ok(phases.includes('变异检查') && phases.includes('gate.mjs --affected') && phases.includes('复审者不重跑全量测试'), '测试阶段缺变异检查、按影响范围或复审者不重跑全量');
});