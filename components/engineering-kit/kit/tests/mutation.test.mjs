// 变异测试接口测试（规格 spec-CD 第 5 节，场景 D2）：run 在没配置、没有源文件时跳过，配置了就把改动的源文件交给外部变异命令并透传退出码；
// pull 从 PR 的 CI 运行里取名为 mutation-report 的产物。业务含义：自动变异测试是可选的“上线前验证”，没配置时必须不影响现有流程，
// 配置了则结果要完整留下（标准输出与标准错误都进报告），供复审者当作输入。gh 用假实现，不访问网络。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fakeGh } from './fixtures/fake-gh.mjs';
import { commitAll, git, tmpDir, tmpRepo, write } from './helpers.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'gate', 'mutation.mjs');

/** 在仓库里运行 mutation 命令行。 */
function cli(root, args, env) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: env ?? process.env });
}

/**
 * 建仓库：基线提交里有 src/a.mjs、src/b.mjs、tests/a.test.mjs；配置按需写 mutationCommand。
 * 变异命令是一个小脚本 mut.mjs：把收到的环境变量写进 marker.json，向标准输出与标准错误各打一行，按 MUT_EXIT 文件里的数字退出。
 */
function repo({ mutationCommand = 'node mut.mjs', exit = 0 } = {}) {
  const root = tmpRepo();
  const gate = mutationCommand === null ? {} : { mutationCommand };
  write(root, 'engineering.config.json', JSON.stringify({ profile: 2, modules: { gate }, layout: { sourceGlobs: ['src/**/*.mjs'], testGlobs: ['tests/**/*.test.mjs'] } }));
  for (const f of ['src/a.mjs', 'src/b.mjs', 'tests/a.test.mjs', 'docs/n.md']) write(root, f, '// base\n');
  write(root, 'mut.mjs', [
    "import fs from 'node:fs';",
    "fs.writeFileSync('marker.json', JSON.stringify({ files: process.env.EK_MUTATION_FILES, json: process.env.EK_MUTATION_FILES_JSON }));",
    "console.log('MUTATION-STDOUT-LINE');",
    "console.error('MUTATION-STDERR-LINE');",
    `process.exit(${exit});`,
    '',
  ].join('\n'));
  write(root, '.gitignore', 'marker.json\nmutation-report.txt\n');
  commitAll(root, 'base');
  return { root, base: git(root, ['rev-parse', 'HEAD']).trim() };
}

test('D2 run：没配置 mutationCommand → 提示 未配置 modules.gate.mutationCommand，跳过自动变异测试（沿用人工变异检查），退出 0，不运行任何命令', () => {
  const { root, base } = repo({ mutationCommand: null });
  write(root, 'src/a.mjs', '// changed\n');
  commitAll(root, 'change');
  const r = cli(root, ['run', '--base', base]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /未配置 modules\.gate\.mutationCommand/);
  assert.match(r.stdout, /跳过自动变异测试/);
  assert.match(r.stdout, /沿用人工变异检查/);
  assert.equal(fs.existsSync(path.join(root, 'marker.json')), false);
});

test('D2 run：配置了但改动里没有源文件（只改文档与测试）→ 打印说明并退出 0，不运行变异命令', () => {
  const { root, base } = repo();
  write(root, 'docs/n.md', 'changed\n');
  write(root, 'tests/a.test.mjs', '// changed\n');
  commitAll(root, 'docs and tests only');
  const r = cli(root, ['run', '--base', base]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.trim().length > 0, '要打印为什么跳过');
  assert.equal(fs.existsSync(path.join(root, 'marker.json')), false, '没有源文件时不运行命令');
});

test('D2 run：改动的源文件经 EK_MUTATION_FILES（换行分隔）与 EK_MUTATION_FILES_JSON（JSON 数组）传入；输出原样写进 --out', () => {
  const { root, base } = repo();
  write(root, 'src/a.mjs', '// changed a\n');
  write(root, 'src/b.mjs', '// changed b\n');
  write(root, 'tests/a.test.mjs', '// changed t\n');
  write(root, 'docs/n.md', 'changed\n');
  commitAll(root, 'change');
  const out = path.join(tmpDir('ekit-mut-'), 'report.txt');
  const r = cli(root, ['run', '--base', base, '--out', out]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const marker = JSON.parse(fs.readFileSync(path.join(root, 'marker.json'), 'utf8'));
  assert.deepEqual(marker.files.split('\n').filter(Boolean).sort(), ['src/a.mjs', 'src/b.mjs'], '只传源文件，不含测试与文档');
  assert.deepEqual(JSON.parse(marker.json).sort(), ['src/a.mjs', 'src/b.mjs']);
  const report = fs.readFileSync(out, 'utf8');
  assert.ok(report.includes('MUTATION-STDOUT-LINE'), '标准输出写进报告');
  assert.ok(report.includes('MUTATION-STDERR-LINE'), '标准错误也写进报告');
});

test('D2 run：变异命令的退出码原样透传；--out 缺省写当前目录的 mutation-report.txt', () => {
  const { root, base } = repo({ exit: 7 });
  write(root, 'src/a.mjs', '// changed\n');
  commitAll(root, 'change');
  const r = cli(root, ['run', '--base', base]);
  assert.equal(r.status, 7, r.stderr + r.stdout);
  const report = fs.readFileSync(path.join(root, 'mutation-report.txt'), 'utf8');
  assert.ok(report.includes('MUTATION-STDOUT-LINE') && report.includes('MUTATION-STDERR-LINE'));
});

test('D2 run：命令经 shell 运行（支持 && 等写法）', () => {
  const { root, base } = repo({ mutationCommand: 'node -e "process.exit(0)" && node mut.mjs' });
  write(root, 'src/a.mjs', '// changed\n');
  commitAll(root, 'change');
  const r = cli(root, ['run', '--base', base]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(fs.existsSync(path.join(root, 'marker.json')));
});

// ---------- pull（假 gh） ----------

const RUN = { databaseId: 301, attempt: 1, status: 'completed', conclusion: 'success', name: 'CI' };

test('D2 pull：下载 PR 最终提交上 CI 运行的 mutation-report 产物，写到 --out 并打印路径', () => {
  const { root } = repo();
  const sha = 'a1'.repeat(20);
  const gh = fakeGh({ prHead: sha, runs: [RUN], artifacts: { 301: { 'mutation-report/mutation-report.txt': 'MUTANTS SURVIVED: 2\n', 'mutation-report.txt': 'MUTANTS SURVIVED: 2\n' } } });
  const out = path.join(tmpDir('ekit-mut-'), 'got.txt');
  const r = cli(root, ['pull', '--pr', '9', '--out', out], gh.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(fs.readFileSync(out, 'utf8'), 'MUTANTS SURVIVED: 2\n');
  assert.ok(r.stdout.includes(out), '打印报告路径，供 external-review.mjs run --context 使用');
  const calls = gh.calls();
  const view = calls.find((c) => c[0] === 'pr' && c[1] === 'view');
  assert.ok(view && view.includes('9') && view.includes('headRefOid'), JSON.stringify(view));
  const list = calls.find((c) => c[0] === 'run' && c[1] === 'list');
  assert.ok(list && list.includes(sha), JSON.stringify(list));
  assert.ok(calls.some((c) => c[1] === 'download' && c.join(' ').includes('mutation-report')), '下载名为 mutation-report 的产物');
});

test('D2 pull：没有产物 → 说明 本 PR 的 CI 没有变异测试产物（没配置、没带风险标签或作业没跑），退出 0', () => {
  const { root } = repo();
  const gh = fakeGh({ prHead: 'c3'.repeat(20), runs: [RUN], artifacts: {} });
  const out = path.join(tmpDir('ekit-mut-'), 'none.txt');
  const r = cli(root, ['pull', '--pr', '9', '--out', out], gh.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /本 PR 的 CI 没有变异测试产物/);
  assert.match(r.stdout, /没配置/);
  assert.match(r.stdout, /风险标签/);
});

// ---------- 首轮复审回归（M3、M10） ----------

const jobsOf = (...jobs) => jobs.map(([name, conclusion]) => ({ name, conclusion }));
const MUT_ART = { 'mutation-report/mutation-report.txt': 'MUTANTS SURVIVED: 5\n', 'mutation-report.txt': 'MUTANTS SURVIVED: 5\n' };

test('M3 pull：有产物但变异作业结论不是 success → 输出 变异作业结论：<结论>，写明报告可能不完整，报告仍写出；success 不加警告', () => {
  const { root } = repo();
  const out = path.join(tmpDir('ekit-mut-'), 'got.txt');
  const gh = fakeGh({ prHead: 'd1'.repeat(20), runs: [RUN], artifacts: { 301: MUT_ART }, jobs: { 301: jobsOf(['test (linux)', 'success'], ['mutation', 'failure']) } });
  const r = cli(root, ['pull', '--pr', '9', '--out', out], gh.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /变异作业结论：failure/);
  assert.match(r.stdout, /不完整/);
  assert.equal(fs.readFileSync(out, 'utf8'), 'MUTANTS SURVIVED: 5\n');
  const view = gh.calls().find((c) => c[0] === 'run' && c[1] === 'view');
  assert.ok(view && view.includes('301') && view.includes('--json') && view.includes('jobs'), JSON.stringify(gh.calls()));
  const ok = fakeGh({ prHead: 'd2'.repeat(20), runs: [RUN], artifacts: { 301: MUT_ART }, jobs: { 301: jobsOf(['mutation', 'success']) } });
  const okRun = cli(root, ['pull', '--pr', '9', '--out', path.join(tmpDir('ekit-mut-'), 'ok.txt')], ok.env);
  assert.equal(okRun.status, 0, okRun.stderr + okRun.stdout);
  assert.doesNotMatch(okRun.stdout, /不完整/);
});

test('M3 pull：没有产物且变异作业结论是 failure / cancelled / timed_out → 输出该结论，不再说通用的 没配置、没带风险标签或作业没跑', () => {
  const { root } = repo();
  for (const conclusion of ['failure', 'cancelled', 'timed_out']) {
    const gh = fakeGh({ prHead: 'e1'.repeat(20), runs: [RUN], artifacts: {}, jobs: { 301: jobsOf(['test (linux)', 'failure'], ['mutation', conclusion]) } });
    const r = cli(root, ['pull', '--pr', '9', '--out', path.join(tmpDir('ekit-mut-'), 'none.txt')], gh.env);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(r.stdout.includes(`变异作业结论：${conclusion}`), r.stdout);
    assert.doesNotMatch(r.stdout, /没配置/);
  }
  const noJob = fakeGh({ prHead: 'e2'.repeat(20), runs: [RUN], artifacts: {}, jobs: { 301: jobsOf(['test (linux)', 'failure']) } });
  const r = cli(root, ['pull', '--pr', '9', '--out', path.join(tmpDir('ekit-mut-'), 'none2.txt')], noJob.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /没配置/, '没有 mutation 作业：仍是通用说明（其他作业失败不算）');
});

test('M10 pull：不给 --out 时写到每次新建的独占临时目录——两次调用的路径不同，也不是固定的 <tmpdir>/ek-mutation-<PR>.txt', () => {
  const { root } = repo();
  const fixed = path.join(os.tmpdir(), 'ek-mutation-4243.txt');
  fs.rmSync(fixed, { force: true });
  const paths = [];
  try {
    for (let i = 0; i < 2; i++) {
      const gh = fakeGh({ prHead: 'b2'.repeat(20), runs: [RUN], artifacts: { 301: { 'mutation-report/mutation-report.txt': 'R\n', 'mutation-report.txt': 'R\n' } } });
      const r = cli(root, ['pull', '--pr', '4243'], gh.env);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const printed = r.stdout.match(/变异测试报告：(.+)/)[1].trim();
      assert.equal(fs.readFileSync(printed, 'utf8'), 'R\n');
      paths.push(path.resolve(printed));
    }
    assert.notEqual(paths[0], paths[1], '两次调用的路径不同');
    assert.notEqual(path.dirname(paths[0]), path.dirname(paths[1]), '各用各的新目录');
    for (const p of paths) {
      assert.notEqual(p, path.resolve(fixed), '不是固定路径');
      assert.notEqual(path.resolve(path.dirname(p)), path.resolve(os.tmpdir()), '放在新建的子目录里，不直接放系统临时目录');
    }
    assert.equal(fs.existsSync(fixed), false, '固定路径不再被写');
  } finally {
    for (const p of paths) {
      // 只删自己的文件；目录只在它正是系统临时目录下、以 ek-mutation- 开头的独占子目录时才删（只删空目录，不递归），绝不碰别的目录
      fs.rmSync(p, { force: true });
      const dir = path.resolve(path.dirname(p));
      if (path.dirname(dir) === path.resolve(os.tmpdir()) && path.basename(dir).startsWith('ek-mutation-')) {
        try { fs.rmdirSync(dir); } catch { /* 目录不空或已删：留给系统清理，不扩大删除范围 */ }
      }
    }
    fs.rmSync(fixed, { force: true });
  }
});
