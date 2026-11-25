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
  // 第 3 步：插件和套件两个标签都要打（套件回滚与升级按 engineering-kit-v<版本> 定位），套件 SKILL.md 里写的约定与这里一致
  assert.match(doc, /3\. 在同一个合并提交创建两个带说明的标签：插件的 `v<插件版本>` 和工程套件的 `engineering-kit-v<套件版本>`/);
  assert.match(read('components/engineering-kit/SKILL.md'), /engineering-kit-vX\.Y\.Z/);
  // 独立复审的时点以项目规则为准
  const rules = read('AGENTS.md');
  assert.match(rules, /Linux、Windows CI 成功后做独立代码复审/);
  assert.match(doc, /Linux、Windows CI 都成功后才做/);
  // 逐格比对：表里每一行按竖线切成格，步骤 2 的几项各在各的位置，不能把双审放进 CI 一栏
  const cells = (label, work) => {
    const line = doc.split('\n').find((l) => l.startsWith(`| ${label} | ${work} |`));
    assert.ok(line, `缺少行：${label} | ${work}`);
    const c = line.split('|').map((x) => x.trim());
    return { where: c[3], who: c[4] };
  };
  const D2 = 'D 发布（第 2 步，合并前）';
  assert.deepEqual(cells(D2, '跨平台全量测试'), { where: 'PR 的 CI（Linux、Windows）', who: '项目规则（AGENTS.md）' });
  const review = cells(D2, '独立代码复审与增量一致性审');
  assert.ok(review.where.includes('Linux、Windows CI 都成功后才做'));
  assert.ok(!review.where.includes('PR 的 CI（Linux、Windows）'), '双审不放在“PR 的 CI”里，时点是 CI 成功之后');
  assert.ok(review.where.includes('宿主子代理') && review.where.includes('外部执行器'));
  assert.ok(cells(D2, '运行 `build-plugin.mjs` 和 `evals`（生成与相关测试）').where.startsWith('当前会话本机跑'));
  const D4 = cells('D 发布（第 4 步）', '在标签对应的提交上打包并核对 SHA256SUMS');
  assert.ok(D4.where.includes('release-artifacts') && D4.where.includes('上传') && D4.where.includes('本机再按第 4 步'));
  // 第 2 步恰好这三项工作（多了或少了、被合并成一行都会失败）
  const works = doc.split('\n').filter((l) => l.startsWith(`| ${D2} |`)).map((l) => l.split('|')[2].trim());
  assert.deepEqual(works, ['运行 `build-plugin.mjs` 和 `evals`（生成与相关测试）', '跨平台全量测试', '独立代码复审与增量一致性审']);
});
