// 综合插件 product-dev 的构建检查。
// 业务含义：插件里“取自组件”的部分必须与组件一致、与锁文件相符；用户能调用的技能只有入口一个；插件单独装好后链接都能到达。
// 运行：在仓库根目录 node --test evals/plugin-build.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { adaptToEngine, assertEngineVerbs, assertNotHandwritten, build, dropSection, ENTRY_SKILL, HANDWRITTEN, hashFiles, hideSkill, IMPECCABLE_ENGINE_GAPS, isHandwritten, mergeEngineVerbs, parseEngineVerbs, PLUGIN_DIR, readTree, referencedVerbs, ROOT } from '../tools/build-plugin.mjs';

const PLUGIN = path.join(ROOT, PLUGIN_DIR);
const LOCK = 'BUILD.lock.json';
const committed = () => readTree(PLUGIN);
const lock = () => JSON.parse(fs.readFileSync(path.join(PLUGIN, LOCK), 'utf8'));
const isThirdParty = (part) => Boolean(part.source);
/** 某个部分在插件里的文件（相对该部分的目标位置）。 */
function partFiles(tree, part) {
  const files = new Map();
  for (const [rel, buf] of tree) {
    if (rel === part.dest) files.set(path.basename(rel), buf);
    else if (rel.startsWith(`${part.dest}/`) && (!part.files || part.files.includes(rel.slice(part.dest.length + 1)))) files.set(rel.slice(part.dest.length + 1), buf);
  }
  return files;
}
/** 把文件树变成“路径 → 内容哈希”，比较时报错信息只列路径。 */
const digest = (tree) => Object.fromEntries([...tree].sort(([a], [b]) => (a < b ? -1 : 1)).map(([rel, buf]) => [rel, hashFiles(new Map([[rel, buf]]))]));
const inTemp = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'product-dev-build-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

test('构建一致：重新构建的结果与仓库里的插件相同，没有多余文件', () => {
  inTemp((out) => {
    const { thirdPartyBuilt } = build({ out, log: () => {} });
    const rebuilt = readTree(out);
    const actual = committed();
    for (const rel of [...HANDWRITTEN, `skills/${ENTRY_SKILL}/SKILL.md`]) assert.ok(actual.has(rel), `缺少手写文件 ${rel}`);
    // 手写部分（入口技能整个目录、清单、声明）不参与比较，由下一条单独检查
    for (const rel of [...actual.keys()].filter(isHandwritten)) actual.delete(rel);
    if (!thirdPartyBuilt) {
      // 本机没有 vendor 存档：只比自有部分，第三方部分由下一条按锁文件校验
      for (const part of lock().parts.filter(isThirdParty)) for (const rel of partFiles(actual, part).keys()) actual.delete(`${part.dest}/${rel}`);
    }
    assert.deepEqual(digest(actual), digest(rebuilt));
  });
});

test('手写部分：构建不生成、不改动、不删除手写文件，锁文件里也没有手写路径', () => {
  inTemp((out) => {
    // 先把仓库里的手写文件原样放进输出目录，再在它上面构建
    const hand = new Map([...committed()].filter(([rel]) => isHandwritten(rel)));
    assert.ok(hand.size >= HANDWRITTEN.length + 7, '没有找到入口技能和它的方法文档');
    for (const [rel, buf] of hand) {
      fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
      fs.writeFileSync(path.join(out, rel), buf);
    }
    const { lock: built } = build({ out, log: () => {} });
    const after = new Map([...readTree(out)].filter(([rel]) => isHandwritten(rel)));
    assert.deepEqual(digest(after), digest(hand));
    for (const part of built.parts) {
      assert.ok(!isHandwritten(part.dest), `锁文件的 ${part.id} 落在手写路径上`);
      for (const rel of part.files || []) assert.ok(!isHandwritten(`${part.dest}/${rel}`), `锁文件的 ${part.id} 列了手写文件 ${rel}`);
    }
  });
  // 空目录上构建：不凭空生成手写文件
  inTemp((out) => {
    build({ out, log: () => {} });
    assert.deepEqual([...readTree(out).keys()].filter(isHandwritten), []);
  });
});

test('手写保护：生成部分落在手写路径或它的上级目录时构建报错', () => {
  const part = (dest, files, listFiles) => ({ id: 'x', dest, listFiles, files: new Map(files.map((f) => [f, Buffer.from('')])) });
  assert.throws(() => assertNotHandwritten(part(`skills/${ENTRY_SKILL}`, ['a.md'])), /手写路径/);
  assert.throws(() => assertNotHandwritten(part(`skills/${ENTRY_SKILL}/references`, ['a.md'])), /手写路径/);
  assert.throws(() => assertNotHandwritten(part('skills', ['other/SKILL.md'])), /手写路径/, '清空 skills 会连入口一起删掉');
  assert.throws(() => assertNotHandwritten(part('.claude-plugin', ['plugin.json'], true)), /手写路径/);
  assert.doesNotThrow(() => assertNotHandwritten(part('skills/engineering-kit', ['SKILL.md'])));
  assert.doesNotThrow(() => assertNotHandwritten(part('agents', ['code-reviewer.md'], true)));
  // 保护要真的接在写入之前：构建脚本写每个部分时先调用它
  const source = fs.readFileSync(path.join(ROOT, 'tools/build-plugin.mjs'), 'utf8');
  assert.match(source, /const write = \(part\) => \{\s*const dest = [^\n]*\n\s*assertNotHandwritten\(part\);/, '构建写入前没有调用手写保护');
});

test('锁文件：每个部分的文件数和内容哈希与锁文件相符，子代理目录没有来历不明的文件', () => {
  const tree = committed();
  const parts = lock().parts;
  assert.ok(parts.filter(isThirdParty).length >= 4, '锁文件里没有第三方部分');
  for (const part of parts) {
    const files = partFiles(tree, part);
    assert.equal(files.size, part.fileCount, `${part.id} 的文件数与锁文件不符`);
    assert.equal(hashFiles(files), part.sha256, `${part.id} 的内容哈希与锁文件不符`);
  }
  const known = new Set(parts.filter((p) => p.dest === 'agents').flatMap((p) => p.files));
  assert.deepEqual([...tree.keys()].filter((rel) => rel.startsWith('agents/') && !known.has(rel.slice(7))), []);
});

test('可执行位：上游标为可执行的文件，在 git 里也记为可执行', () => {
  const expected = lock().parts.flatMap((p) => (p.executable || []).map((rel) => `${PLUGIN_DIR}/${p.dest}/${rel}`)).sort();
  assert.ok(expected.length >= 2, '锁文件里没有记录可执行文件');
  const actual = execFileSync('git', ['-C', ROOT, 'ls-files', '-s', '-z', '--', PLUGIN_DIR], { encoding: 'utf8' }).split('\0').filter((l) => l.startsWith('100755')).map((l) => l.split('\t')[1]).sort();
  assert.deepEqual(actual, expected);
});

// 局限：没有 vendor 存档的机器上，第三方部分只能与同一提交里的锁文件互相对照；内容和锁文件被同时改掉时查不出来，要在有存档的机器上重建才能发现。
test('没有 vendor 存档：只重建自有部分，第三方部分沿用锁文件，不报错', () => {
  inTemp((out) => {
    const notes = [];
    const { lock: built, thirdPartyBuilt } = build({ out, vendor: path.join(out, 'no-vendor'), log: (m) => notes.push(m) });
    assert.equal(thirdPartyBuilt, false);
    assert.equal(notes.length, 1, '应提示一次没有找到存档');
    assert.deepEqual(built, lock(), '锁文件应与仓库里的一致（第三方部分沿用）');
    const rebuilt = readTree(out);
    assert.ok(rebuilt.has('skills/engineering-kit/SKILL.md'));
    assert.deepEqual([...rebuilt.keys()].filter((rel) => /^(agents|skills\/(impeccable|archify))\//.test(rel)), []);
  });
});

// 引擎命令表在有 vendor 存档的机器上从上游 engine-v<版本> 标签读出、写进锁文件；这里不需要存档，用锁文件核对已提交的文本。
test('impeccable 引擎：文本引用的命令都在固定引擎里，锁文件记录的引擎版本与 scripts/VERSION 一致', () => {
  const tree = committed();
  const part = lock().parts.find((p) => p.id === 'impeccable');
  assert.ok(part?.engine?.verbs?.length >= 20, '锁文件没有记录 impeccable 固定引擎的命令表');
  assert.match(part.engine.tagCommit || '', /^[0-9a-f]{40}$/, '锁文件没有记录引擎标签对应的提交');
  assert.equal(tree.get('skills/impeccable/scripts/VERSION').toString('utf8').trim(), part.engine.version, '锁文件的引擎版本与 scripts/VERSION 不一致，要重新构建');
  const engine = { version: part.engine.version, verbs: new Set(part.engine.verbs) };
  const texts = new Map([...tree].filter(([rel]) => rel.startsWith('skills/impeccable/') || /^agents\/impeccable-/.test(rel)));
  assert.ok(referencedVerbs(texts).size >= 15, '没有找到 impeccable 文本里调用引擎的命令');
  assert.doesNotThrow(() => assertEngineVerbs(texts, engine));
  // 登记过的本地适配要真的落在成品里
  for (const gap of IMPECCABLE_ENGINE_GAPS) {
    assert.ok(!engine.verbs.has(gap.verb), `固定引擎已支持 ${gap.verb}，应删掉这条本地适配`);
    for (const rel of gap.files) {
      const text = tree.get(`skills/impeccable/${rel}`).toString('utf8');
      assert.ok(!text.split('\n').includes(gap.heading), `${rel} 仍有“${gap.heading}”一节`);
      assert.match(text, /Modified by the product-dev plugin build/, `${rel} 缺少改动说明`);
    }
  }
});

test('impeccable 引擎适配：解析命令表、去掉缺口一节、引擎补上命令或文本引用未知命令时报错', () => {
  const rust = [
    'fn helper(x: &str) {',
    '    match x {',
    '        "json" => 1,',
    '    }',
    '}',
    'pub fn run(verb: &str) -> i32 {',
    '    match verb {',
    '        "detect" => detect(rest),',
    '        "ignores" | "ignore" => x(),',
    '        "comp-diff" => {',
    '        v if v.starts_with("live") => live(v),',
    '        _ => other(),',
    '    }',
    '    let s = "not-a-verb";',
    '}',
    'fn later(y: &str) { match y {',
    '        "after" => 2,',
    '    } }',
  ].join('\n');
  const parsed = parseEngineVerbs(rust);
  assert.deepEqual([...parsed.verbs].sort(), ['comp-diff', 'detect', 'ignore', 'ignores'], 'run 函数体外的 match 不算命令');
  assert.deepEqual([...parsed.prefixes], ['live']);
  assert.throws(() => parseEngineVerbs('fn main() {}'), /pub fn run/);
  const live = parseEngineVerbs('pub fn run(v: &str) {\n    match v {\n        "live" => a(),\n        "live-poll" | "poll" => b(),\n        "live-status" | "status" => c(),\n    }\n}\n');
  assert.deepEqual([...mergeEngineVerbs(parsed, { live })].sort(), ['comp-diff', 'detect', 'ignore', 'ignores', 'live', 'live-poll', 'live-status'], '子模块里不带前缀的别名从命令行调不到');
  assert.deepEqual([...mergeEngineVerbs({ verbs: new Set(['detect']), prefixes: new Set() }, { live })], ['detect'], '没有前缀分派时不并入子模块');

  const refs = referencedVerbs(new Map([['a.md', Buffer.from('run `"<skill-base-dir>/scripts/impeccable" detect x`, `impeccable concept-seed --check`, `npx impeccable update`, "<skill-base-dir>/scripts/impeccable.cmd" pin, /impeccable polish, `impeccable` reports')]]));
  assert.deepEqual([...refs.keys()].sort(), ['concept-seed', 'detect', 'pin', 'update']);

  const doc = Buffer.from('# T\n\ntext\n\n## Save\n\nrun `"<skill-base-dir>/scripts/impeccable" gone write x`\n\n```sh\n# not a heading\n```\n\n### Sub\n\nmore\n\n## Next\n\nkeep\n');
  assert.equal(dropSection(doc, '## Save', '<!-- note -->').toString(), '# T\n\ntext\n\n<!-- note -->\n\n## Next\n\nkeep\n');
  assert.equal(dropSection(Buffer.from('# T\n\ntext\n\n## Save\n\nlast\n'), '## Save', '<!-- n -->').toString(), '# T\n\ntext\n\n<!-- n -->\n');
  assert.equal(dropSection(Buffer.from('# T\r\n\r\ntext\r\n\r\n## Save\r\n\r\nlast'), '## Save', '<!-- n -->').toString(), '# T\r\n\r\ntext\r\n\r\n<!-- n -->', '保留 CRLF 和“末尾没有换行”');
  assert.equal(dropSection(Buffer.from('## Save\n\nx\n\n## Next\n'), '## Save', '<!-- n -->').toString(), '<!-- n -->\n\n## Next\n', '在文件开头时不留空行');
  assert.throws(() => dropSection(Buffer.from('```\n## Save\n```\n'), '## Save', 'n'), /没有找到/, '代码块里的同名行不是标题');
  assert.throws(() => dropSection(doc, '## Missing', 'n'), /没有找到/);

  const gap = { verb: 'gone', heading: '## Save', files: ['a.md'] };
  const files = () => new Map([['a.md', doc], ['b.md', Buffer.from('"<skill-base-dir>/scripts/impeccable" detect x')]]);
  const engine = { version: '9.9.9', verbs: new Set(['detect']) };
  const adapted = files();
  assert.deepEqual(adaptToEngine(adapted, engine, [gap]), { version: '9.9.9', verbs: ['detect'] });
  assert.doesNotMatch(adapted.get('a.md').toString(), /gone write|### Sub/);
  assert.match(adapted.get('a.md').toString(), /pinned engine 9\.9\.9 has no `gone` command/);
  assert.throws(() => adaptToEngine(files(), engine, []), /gone（a\.md）/, '未登记的缺口要报错');
  assert.throws(() => adaptToEngine(files(), { version: '9.9.10', verbs: new Set(['detect', 'gone']) }, [gap]), /已支持 gone/, '引擎补上命令后要提示撤回适配');
});

test('入口唯一：插件里可由用户调用的技能只有入口一个', () => {
  const skills = [...committed().keys()].filter((rel) => path.basename(rel) === 'SKILL.md');
  assert.ok(skills.length >= 8, '没有找到插件里的技能');
  const invocable = skills.filter((rel) => !/^user-invocable: false\r?$/m.test(frontmatter(rel)));
  assert.deepEqual(invocable, [`skills/${ENTRY_SKILL}/SKILL.md`]);
  const entry = frontmatter(`skills/${ENTRY_SKILL}/SKILL.md`);
  assert.doesNotMatch(entry, /^disable-model-invocation:/m, '入口技能要能被模型自动加载');
  assert.match(entry, new RegExp(`^name: ${ENTRY_SKILL}$`, 'm'));
  // 内部技能必须能被模型加载，否则入口交不出去
  for (const rel of skills) assert.doesNotMatch(frontmatter(rel), /^disable-model-invocation: true/m, `${rel} 不能被模型加载`);
});

test('改头部：去掉禁止模型加载、统一为不出现在菜单，正文不动', () => {
  const out = hideSkill(Buffer.from('---\nname: x\ndisable-model-invocation: true\nuser-invocable: true\n---\n\n正文 user-invocable: true\n'), '# 注').toString();
  assert.equal(out, '---\nname: x\nuser-invocable: false\n# 注\n---\n\n正文 user-invocable: true\n');
  assert.throws(() => hideSkill(Buffer.from('没有文件头')));
});

test('链接：插件里所有相对链接都落在插件内并且存在', () => {
  const tree = committed();
  const broken = [];
  for (const [rel, buf] of tree) {
    // 工程套件模板里的链接相对装进项目后的位置，不在这里查
    if (!rel.endsWith('.md') || rel.startsWith('skills/engineering-kit/kit/templates/')) continue;
    const text = buf.toString('utf8').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^([a-z][a-z0-9+.-]*:|#)/i.test(m[1])) continue;
      let file;
      try { file = decodeURIComponent(m[1].split('#')[0].split('?')[0]); } catch { file = m[1]; }
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), file)).replace(/\/$/, '');
      const exists = tree.has(target) || [...tree.keys()].some((k) => k.startsWith(`${target}/`));
      if (target.startsWith('..') || !exists) broken.push(`${rel} → ${m[1]}`);
    }
  }
  assert.deepEqual(broken, []);
});

test('清单与声明：两个插件清单一致，第三方声明覆盖锁文件里的每个第三方组件及其版本', () => {
  const claude = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin/plugin.json'), 'utf8'));
  const codex = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.codex-plugin/plugin.json'), 'utf8'));
  for (const key of ['name', 'version', 'description', 'license']) assert.equal(claude[key], codex[key], `两个清单的 ${key} 不一致`);
  assert.equal(claude.name, ENTRY_SKILL);
  assert.match(claude.license, /THIRD_PARTY_NOTICES\.md/);
  const notices = fs.readFileSync(path.join(PLUGIN, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  const components = fs.readFileSync(path.join(ROOT, 'COMPONENTS.md'), 'utf8');
  for (const part of lock().parts.filter(isThirdParty)) {
    const section = notices.split(/^## /m).find((s) => new RegExp(`^\\d+\\. ${part.component}$`).test(s.split('\n')[0]));
    assert.ok(section, `第三方声明里没有 ${part.component} 一节`);
    assert.ok(section.includes(part.source), `${part.component} 一节没有写来源 ${part.source}`);
    assert.ok(section.includes(`版本：${part.version}`), `${part.component} 一节的版本不是 ${part.version}`);
    assert.ok(section.includes(`原许可：${part.license}`), `${part.component} 一节的许可不是 ${part.license}`);
    if (part.commit) assert.ok(section.includes(part.commit.slice(0, 7)), `${part.component} 一节的提交不是 ${part.commit.slice(0, 7)}`);
    assert.ok(components.split('\n').some((l) => l.startsWith(`| ${part.component} |`) && l.includes(part.version)), `COMPONENTS.md 里 ${part.component} 的版本不是 ${part.version}`);
  }
  for (const text of ['Apache License', 'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION', 'Permission is hereby granted, free of charge']) assert.ok(notices.includes(text), `第三方声明缺少许可全文：${text}`);
  // 取自 Apache-2.0 项目的技能目录里保留原许可与声明文件
  const tree = committed();
  for (const rel of ['skills/impeccable/LICENSE', 'skills/impeccable/NOTICE.md', 'skills/archify/LICENSE', 'skills/archify/LICENSE-MIT', 'skills/archify/NOTICE', 'skills/archify/THIRD_PARTY_NOTICES.md', 'LICENSE']) assert.ok(tree.has(rel), `缺少 ${rel}`);
});

function frontmatter(rel) {
  const m = fs.readFileSync(path.join(PLUGIN, rel), 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(m, `${rel} 没有文件头`);
  return m[1];
}

test('套件自洽：插件里 kit 脚本的相对导入都存在，技能文本点名的 kit/tools 脚本和 kit/tests 都随插件带着（不排除它们的依据）', () => {
  const kitRoot = path.join(PLUGIN, 'skills', 'engineering-kit');
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.mjs')) files.push(p);
    }
  };
  walk(path.join(kitRoot, 'kit'));
  assert.ok(files.length > 20, '没有找到套件脚本');
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|(?:^|\n)\s*import\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const rel = m[1] ?? m[2];
      assert.ok(fs.existsSync(path.resolve(path.dirname(f), rel)), `${path.relative(PLUGIN, f)} 导入的 ${rel} 不在插件里`);
    }
  }
  const skill = fs.readFileSync(path.join(kitRoot, 'SKILL.md'), 'utf8');
  const named = [...skill.matchAll(/<kit>\/tools\/([a-z-]+\.mjs)/g)].map((m) => m[1]);
  assert.ok(named.includes('changeset.mjs') && named.includes('release.mjs'), '套件技能文本应点名变更集与发布脚本');
  for (const n of new Set(named)) assert.ok(fs.existsSync(path.join(kitRoot, 'kit', 'tools', n)), `技能文本点名的 kit/tools/${n} 不在插件里`);
  assert.ok(skill.includes('node --test tests/*.test.mjs'), '技能文本应写明套件的测试命令');
  assert.ok(fs.readdirSync(path.join(kitRoot, 'kit', 'tests')).some((n) => n.endsWith('.test.mjs')), '技能文本要求运行的 kit/tests 不在插件里');
});
