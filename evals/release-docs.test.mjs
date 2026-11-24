// 发布维护文档的执行位置表（docs/release/README.md）与实际流程对齐。业务含义：
//   表里每个发布步骤的去处要与现有工作流和项目规则一致——第 4 步的产物由标签工作流上传、本机再核对；
//   独立复审在 Linux、Windows CI 都成功后才做；E 是发布后验收。文字改了而事实没变（或相反）时这里会失败。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('发布维护的执行位置表：步骤 2–6 都有对应行，与标签工作流和项目规则一致', () => {
  const doc = read('docs/release/README.md');
  for (const row of ['D 发布（第 2 步，合并前）', 'D 发布（第 3 步）', 'D 发布（第 4 步）', 'D 发布（第 5–6 步的对外部分）', 'E 发布后验收（第 6 步的回读与验收）']) {
    assert.ok(doc.includes(`| ${row} |`), `缺少行：${row}`);
  }
  // 第 4 步：标签工作流确实上传产物，文档不能再说“只打包、不上传”
  const wf = read('.github/workflows/release-artifacts.yml');
  assert.match(wf, /upload-artifact/);
  assert.match(wf, /SHA256SUMS\.txt/);
  assert.ok(doc.includes('release-artifacts'), '第 4 步写明标签工作流');
  assert.ok(!/只打包、不上传|目前只打包/.test(doc), '不能再说 CI 只打包不上传');
  // 独立复审的时点以项目规则为准
  const rules = read('AGENTS.md');
  assert.match(rules, /Linux、Windows CI 成功后做独立代码复审/);
  assert.match(doc, /Linux、Windows CI 都成功后才做/);
  // 两处步骤 2 的工作分在本机与 CI，不能把“双审”写进 CI 一栏
  assert.ok(!/\| D 发布（第 2 步，合并前） \| 跨平台全量测试、双审 \|/.test(doc));
});
