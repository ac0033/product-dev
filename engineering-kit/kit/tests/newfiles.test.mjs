// 新文件规则测试：推送核对要拦截不在白名单、又没有理由的新文件（文档位置与顶层目录）。
// 业务含义：目录和文件的增长要有章法。新文件必须落在阶段目录、记录目录或索引里；否则要在豁免表写明理由。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verify } from '../gate/verify.mjs';
import { featureRepo, write } from './helpers.mjs';

/** 写入豁免表（newFiles 段）。 */
function exempt(root, newFiles) {
  write(root, 'scripts/engineering/exempt.json', JSON.stringify({ testFirst: {}, comments: {}, newFiles }, null, 2));
}

test('新文档：不在阶段目录或记录目录里，且没有理由 → 推送核对拦截', () => {
  const root = featureRepo();
  write(root, 'docs/random-notes.md', '随手记的东西\n');
  const res = verify({ root });
  assert.ok(res.problems.some((p) => /允许的文档位置/.test(p) && /random-notes\.md/.test(p)), JSON.stringify(res.problems));
});

test('新文档：落在阶段目录里 → 不因位置被拦', () => {
  const root = featureRepo();
  write(root, 'docs/04-开发/功能契约.md', '状态：draft\n');
  const res = verify({ root });
  assert.ok(!res.problems.some((p) => /允许的文档位置/.test(p)), JSON.stringify(res.problems));
});

test('新顶层目录：不在白名单 → 拦截；以点开头的工具目录（如 .claude）不拦', () => {
  const root = featureRepo();
  write(root, 'junk/a.txt', 'x\n');
  write(root, '.tooling/b.txt', 'y\n');
  const res = verify({ root });
  assert.ok(res.problems.some((p) => /顶层目录不在白名单.*junk/.test(p)), JSON.stringify(res.problems));
  assert.ok(!res.problems.some((p) => /新文件所在顶层目录.*tooling/.test(p)), JSON.stringify(res.problems));
});

test('豁免表 newFiles：写明理由后放行', () => {
  const root = featureRepo();
  write(root, 'docs/random-notes.md', '随手记的东西\n');
  exempt(root, { 'docs/random-notes.md': '一次性的会议纪要，已约定只保留三个月' });
  const res = verify({ root });
  assert.ok(!res.problems.some((p) => /random-notes/.test(p)), JSON.stringify(res.problems));
});

