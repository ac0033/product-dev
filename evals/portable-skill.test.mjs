// 便携技能包的交付契约。宿主只发现入口，工作流仍能加载内部资料和工程脚本。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { buildPortableSkill } from '../tools/build-portable-skill.mjs';

test('便携包只有一个可发现入口，内部资料随包交付', (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'product-dev-portable-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const output = path.join(scratch, 'product-dev');
  buildPortableSkill(output);

  const files = fs.readdirSync(output, { recursive: true });
  assert.deepEqual(files.filter((file) => /^skill\.md$/i.test(path.basename(file))), ['SKILL.md']);
  const read = (file) => fs.readFileSync(path.join(output, file), 'utf8');
  const entry = read('SKILL.md');
  assert.match(entry, /^name: product-dev$/m);
  assert.match(entry, /references\/product-dev\/skills\/product-dev\/WORKFLOW\.md/);

  const payload = 'references/product-dev';
  const workflow = read(payload + '/skills/product-dev/WORKFLOW.md');
  const links = [...workflow.matchAll(/\]\(([^)\s#]+)(?:#[^)\s]+)?\)/g)];
  for (const [, link] of links) {
    assert.ok(fs.existsSync(path.join(output, payload, 'skills/product-dev', link)), link);
  }
  assert.match(workflow, /\.\.\/engineering-kit\/WORKFLOW\.md/);
  assert.match(read(payload + '/skills/engineering-kit/references/process.md'), /\.\.\/WORKFLOW\.md/);
  assert.match(read(payload + '/skills/product-dev/references/debugging.md'), /skills\/debugging-and-error-recovery\/SKILL\.md/);
  assert.match(read(payload + '/THIRD_PARTY_NOTICES.md'), /\]\(BUILD\.lock\.json\)/);
  assert.equal(read(payload + '/BUILD.lock.json'), fs.readFileSync(new URL('../plugin/BUILD.lock.json', import.meta.url), 'utf8'));
  assert.ok(fs.existsSync(path.join(output, payload, 'agents/code-reviewer.md')));

  const project = path.join(scratch, 'project');
  fs.mkdirSync(project);
  const kit = path.join(output, payload, 'skills/engineering-kit/kit/sync.mjs');
  const probe = spawnSync(process.execPath, [kit, '--target', project, '--init', '--dry-run'], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stdout + probe.stderr);
  assert.deepEqual(fs.readdirSync(project), []);
  assert.throws(() => buildPortableSkill(output), { code: 'EEXIST' });
  assert.equal(read('SKILL.md'), entry);
});
