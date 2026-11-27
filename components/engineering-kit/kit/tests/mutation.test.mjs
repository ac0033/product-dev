// 变异测试接口测试（规格 spec-CD 第 5 节，场景 D2）：run 在没配置、没有源文件时跳过，配置了就把改动的源文件交给外部变异命令并透传退出码；
// pull 从 PR 的 CI 运行里取名为 mutation-report 的产物。业务含义：自动变异测试是可选的“上线前验证”，没配置时必须不影响现有流程，
// 配置了则结果要完整留下（标准输出与标准错误都进报告），供复审者当作输入。gh 用假实现，不访问网络。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
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
/** 一份带状态文件的变异产物（两种下载布局各放一份）：exitCode 为 null 时不放状态文件。 */
function mutArt(report, exitCode, files = ['src/a.mjs']) {
  const art = { 'mutation-report/mutation-report.txt': report, 'mutation-report.txt': report };
  if (exitCode !== null) {
    const status = JSON.stringify({ schema: 'ek-mutation-status/1', exitCode, files });
    art['mutation-report/mutation-status.json'] = status;
    art['mutation-status.json'] = status;
  }
  return art;
}

test('M3 pull：有产物但变异作业结论不是 success → 输出 变异作业结论：<结论>，写明报告可能不完整，报告仍写出；success 不加警告', () => {
  const { root } = repo();
  const out = path.join(tmpDir('ekit-mut-'), 'got.txt');
  const gh = fakeGh({ prHead: 'd1'.repeat(20), runs: [RUN], artifacts: { 301: mutArt('MUTANTS SURVIVED: 5\n', 1) }, jobs: { 301: jobsOf(['test (linux)', 'success'], ['mutation', 'failure']) } });
  const r = cli(root, ['pull', '--pr', '9', '--out', out], gh.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /变异作业结论：failure/);
  assert.match(r.stdout, /不完整/);
  assert.equal(fs.readFileSync(out, 'utf8'), 'MUTANTS SURVIVED: 5\n');
  const view = gh.calls().find((c) => c[0] === 'run' && c[1] === 'view');
  assert.ok(view && view.includes('301') && view.includes('--json') && view.includes('jobs'), JSON.stringify(gh.calls()));
  const ok = fakeGh({ prHead: 'd2'.repeat(20), runs: [RUN], artifacts: { 301: mutArt('MUTANTS SURVIVED: 5\n', 0) }, jobs: { 301: jobsOf(['mutation', 'success']) } });
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

test('M10 pull：不给 --out 时写到每次新建的独占临时目录——两次调用的路径不同，也不是固定的 <tmpdir>/ek-mutation-<PR>.txt（子进程的 TMP/TEMP/TMPDIR 指向本用例自己的目录，只在其中检查）', () => {
  const { root } = repo();
  const sandbox = tmpDir('ekit-mut-tmp-'); // 本用例独占的“系统临时目录”；不碰真正的系统临时目录
  const fixed = path.join(sandbox, 'ek-mutation-4243.txt');
  const paths = [];
  for (let i = 0; i < 2; i++) {
    const gh = fakeGh({ prHead: 'b2'.repeat(20), runs: [RUN], artifacts: { 301: { 'mutation-report/mutation-report.txt': 'R\n', 'mutation-report.txt': 'R\n' } } });
    const env = { ...gh.env, TMP: sandbox, TEMP: sandbox, TMPDIR: sandbox };
    const r = cli(root, ['pull', '--pr', '4243'], env);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const printed = r.stdout.match(/变异测试报告：(.+)/)[1].trim();
    assert.equal(fs.readFileSync(printed, 'utf8'), 'R\n');
    paths.push(path.resolve(printed));
  }
  assert.notEqual(paths[0], paths[1], '两次调用的路径不同');
  assert.notEqual(path.dirname(paths[0]), path.dirname(paths[1]), '各用各的新目录');
  for (const p of paths) {
    assert.ok(p.startsWith(path.resolve(sandbox) + path.sep), `报告写在子进程的临时目录里：${p}`);
    assert.notEqual(p, path.resolve(fixed), '不是固定路径');
    assert.notEqual(path.resolve(path.dirname(p)), path.resolve(sandbox), '放在新建的子目录里，不直接放临时目录');
  }
  assert.equal(fs.existsSync(fixed), false, '固定路径不再被写');
  // 清理：沙盒是本用例自己建的，随临时目录一起由系统清理；这里不删除任何别处的文件
});

// ---------- 第 2 轮复审回归（规格第 10 节：变异状态 M1、M2/M3） ----------

test('R2-6 run：在报告旁写 mutation-status.json（schema、exitCode、files）；变异命令退出码非 0 时 exitCode 照写、files 是传给命令的源文件', () => {
  const { root, base } = repo({ exit: 7 });
  write(root, 'src/a.mjs', '// changed a\n');
  write(root, 'src/b.mjs', '// changed b\n');
  commitAll(root, 'change');
  const dir = tmpDir('ekit-mut-');
  const out = path.join(dir, 'report.txt');
  const r = cli(root, ['run', '--base', base, '--out', out]);
  assert.equal(r.status, 7, r.stderr + r.stdout);
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'mutation-status.json'), 'utf8'));
  assert.equal(status.schema, 'ek-mutation-status/1');
  assert.equal(status.exitCode, 7);
  assert.deepEqual([...status.files].sort(), ['src/a.mjs', 'src/b.mjs']);
  const ok = repo({ exit: 0 });
  write(ok.root, 'src/a.mjs', '// changed a\n');
  commitAll(ok.root, 'change');
  const dir2 = tmpDir('ekit-mut-');
  assert.equal(cli(ok.root, ['run', '--base', ok.base, '--out', path.join(dir2, 'report.txt')]).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir2, 'mutation-status.json'), 'utf8')).exitCode, 0);
});

test('R2-6 run：没有源文件而跳过时也写状态文件：exitCode 0、skipped 为 没有源文件，报告文件写明跳过原因', () => {
  const { root, base } = repo();
  write(root, 'docs/n.md', 'changed\n');
  commitAll(root, 'docs only');
  const dir = tmpDir('ekit-mut-');
  const out = path.join(dir, 'report.txt');
  const r = cli(root, ['run', '--base', base, '--out', out]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'mutation-status.json'), 'utf8'));
  assert.equal(status.schema, 'ek-mutation-status/1');
  assert.equal(status.exitCode, 0);
  assert.equal(status.skipped, '没有源文件');
  assert.ok(fs.readFileSync(out, 'utf8').includes('没有源文件'), '报告文件写明跳过原因');
});

test('R2-6 pull：状态文件 exitCode 为 0 → 完整，不出现 不完整；输出写明 报告来自运行 <id>', () => {
  const { root } = repo();
  const gh = fakeGh({ prHead: 'f1'.repeat(20), runs: [RUN], artifacts: { 301: mutArt('R\n', 0) }, jobs: { 301: jobsOf(['mutation', 'success']) } });
  const r = cli(root, ['pull', '--pr', '9', '--out', path.join(tmpDir('ekit-mut-'), 'got.txt')], gh.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.doesNotMatch(r.stdout, /不完整/);
  assert.match(r.stdout, /报告来自运行 301/);
});

test('R2-6 pull：状态文件 exitCode 非 0 → 输出 变异命令退出码 <n> 与 不完整；报告仍写出', () => {
  const { root } = repo();
  const out = path.join(tmpDir('ekit-mut-'), 'got.txt');
  const gh = fakeGh({ prHead: 'f2'.repeat(20), runs: [RUN], artifacts: { 301: mutArt('R2\n', 3) }, jobs: { 301: jobsOf(['mutation', 'success']) } });
  const r = cli(root, ['pull', '--pr', '9', '--out', out], gh.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /变异命令退出码 ?3/);
  assert.match(r.stdout, /不完整/);
  assert.equal(fs.readFileSync(out, 'utf8'), 'R2\n');
});

test('R2-6 pull：有报告没有状态文件 → 输出 没有状态文件 与 不完整（步骤可能超时或被取消）', () => {
  const { root } = repo();
  const gh = fakeGh({ prHead: 'f3'.repeat(20), runs: [RUN], artifacts: { 301: mutArt('R\n', null) }, jobs: { 301: jobsOf(['mutation', 'success']) } });
  const r = cli(root, ['pull', '--pr', '9', '--out', path.join(tmpDir('ekit-mut-'), 'got.txt')], gh.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /没有状态文件/);
  assert.match(r.stdout, /不完整/);
});

test('R2-6 pull：gh run view 绑定到该次 attempt（带 --attempt <attempt>）', () => {
  const { root } = repo();
  const run = { ...RUN, attempt: 3 };
  const gh = fakeGh({ prHead: 'f4'.repeat(20), runs: [run], artifacts: { 301: mutArt('R\n', 0) }, jobs: { 301: jobsOf(['mutation', 'success']) } });
  const r = cli(root, ['pull', '--pr', '9', '--out', path.join(tmpDir('ekit-mut-'), 'got.txt')], gh.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const views = gh.calls().filter((c) => c[0] === 'run' && c[1] === 'view');
  assert.ok(views.length >= 1 && views.every((c) => c.includes('--attempt') && c[c.indexOf('--attempt') + 1] === '3'), JSON.stringify(views));
});

test('R2-6 pull：最新有 mutation 作业的运行没有产物、更早的运行有 → 用较早的报告，输出 可能过期 与两个运行号', () => {
  const { root } = repo();
  const newer = { ...RUN, databaseId: 302, conclusion: 'failure' };
  const older = { ...RUN, databaseId: 301 };
  const out = path.join(tmpDir('ekit-mut-'), 'got.txt');
  const gh = fakeGh({ prHead: 'f5'.repeat(20), runs: [newer, older], artifacts: { 301: mutArt('OLD\n', 0) },
    jobs: { 302: jobsOf(['mutation', 'failure']), 301: jobsOf(['mutation', 'success']) } });
  const r = cli(root, ['pull', '--pr', '9', '--out', out], gh.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /可能过期/);
  assert.ok(r.stdout.includes('302') && r.stdout.includes('301'), r.stdout);
  assert.equal(fs.readFileSync(out, 'utf8'), 'OLD\n');
});

test('R2-6 pull：报告所在运行里找不到 mutation 作业 → 输出 未能确认报告对应的变异作业', () => {
  const { root } = repo();
  const gh = fakeGh({ prHead: 'f6'.repeat(20), runs: [RUN], artifacts: { 301: mutArt('R\n', 0) }, jobs: { 301: jobsOf(['test (linux)', 'success']) } });
  const r = cli(root, ['pull', '--pr', '9', '--out', path.join(tmpDir('ekit-mut-'), 'got.txt')], gh.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /未能确认报告对应的变异作业/);
});

test('R2-6 pull：一个产物都没有且最新 mutation 作业结论是 failure → 输出 变异作业结论：failure，不说通用的没配置', () => {
  const { root } = repo();
  const gh = fakeGh({ prHead: 'f7'.repeat(20), runs: [{ ...RUN, conclusion: 'failure' }], artifacts: {}, jobs: { 301: jobsOf(['mutation', 'failure']) } });
  const r = cli(root, ['pull', '--pr', '9', '--out', path.join(tmpDir('ekit-mut-'), 'none.txt')], gh.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /变异作业结论：failure/);
  assert.doesNotMatch(r.stdout, /没配置/);
});
