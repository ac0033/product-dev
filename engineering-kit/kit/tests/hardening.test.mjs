// 复审后的加固测试：Python 多行文件头、基准分支解析失败时拒绝（不放行）、未提交改动、非源文件改动也要记录、
// 钩子对 gh/git 全局选项与 .exe 的识别。每个用例对应一条复审发现，修复前应失败。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { classify } from '../hooks/pre-bash.mjs';
import { checkComments } from '../gate/check-comments.mjs';
import os from 'node:os';
import { changedFiles, loadConfig, uncommittedInScope } from '../gate/lib.mjs';
import { verify } from '../gate/verify.mjs';
import { featureRepo, tmpRepo, write, TEST_CONFIG } from './helpers.mjs';

test('未提交检查：git 失败时抛错，绝不返回空列表（失败不放行）', () => {
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ekit-norepo-'));
  assert.throws(() => uncommittedInScope(notRepo, ['src/a.ts']), /git status 失败/);
});

test('未提交检查：只报告范围内的未提交文件，范围外的忽略', () => {
  const root = featureRepo();
  write(root, 'src/dedup.ts', 'changed in scope\n');
  write(root, 'docs/note.md', 'outside scope\n');
  assert.deepEqual(uncommittedInScope(root, ['src/dedup.ts']), ['src/dedup.ts']);
});

const pyCfg = { ...TEST_CONFIG, commentMode: 'header' };

test('文件头：Python 多行文档字符串的正文算作注释', () => {
  const root = tmpRepo();
  write(root, 'src/rank.py', '"""\n业务说明：这是跨多行的文件头，描述排序模块的职责与边界。\n"""\n\n\ndef rank(x):\n    return x\n');
  assert.deepEqual(checkComments({ root, files: ['src/rank.py'], config: pyCfg, exempt: {} }), []);
});

test('文件头：单行文档字符串的标记不计入字数（"""Short.""" 不够 8 个字）', () => {
  const root = tmpRepo();
  write(root, 'src/rank.py', '"""Short."""\n\n\ndef rank(x):\n    return x\n');
  const problems = checkComments({ root, files: ['src/rank.py'], config: pyCfg, exempt: {} });
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /文件头注释/);
});

test('基准分支解析不了：改动范围计算直接报错，不返回空列表', () => {
  const root = featureRepo();
  write(root, 'src/dedup.ts', 'changed\n');
  assert.throws(() => changedFiles(root, 'origin/does-not-exist'), /基准/);
});

test('推送核对：范围内有未提交改动时拒绝（推送的是提交，闸门核对的必须是同一份代码）', () => {
  const root = featureRepo();
  write(root, 'src/dedup.ts', '// 去重模块：按标题相似度合并重复资源，是导入流程的一步。\nexport function dedup(a) {\n  return a;\n}\n');
  write(root, 'test/dedup.test.ts', "import { dedup } from '../src/dedup.ts';\nconsole.log(dedup, 'x');\n");
  const res = verify({ root });
  assert.equal(res.ok, false);
  assert.ok(res.problems.some((p) => /未提交/.test(p)), JSON.stringify(res.problems));
});

test('推送核对：非源文件的改动（如闸门脚本、配置）同样需要测试与复审记录', () => {
  const root = featureRepo();
  write(root, 'scripts/tool.mjs', 'process.exit(0);\n');
  const res = verify({ root });
  assert.equal(res.ok, false);
  assert.ok(res.problems.some((p) => /没有测试记录/.test(p)), JSON.stringify(res.problems));
});

test('钩子：gh 带全局选项、gh.exe、git 选项带等号、git.exe 都要识别', () => {
  assert.equal(classify('gh -R owner/repo pr merge 3 --squash'), 'merge');
  assert.equal(classify('gh.exe pr merge 3'), 'merge');
  assert.equal(classify('git --git-dir=.git push origin feat'), 'push');
  assert.equal(classify('git.exe push origin feat'), 'push');
  assert.equal(classify('gh -R owner/repo pr create --draft'), 'push');
});

test('配置读取：缺省基准分支是 auto（自动识别，不写死远程名）', () => {
  const root = tmpRepo();
  write(root, 'engineering.config.json', '{}\n');
  assert.equal(loadConfig(root).base, 'auto');
});

