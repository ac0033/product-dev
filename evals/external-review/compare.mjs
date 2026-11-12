// 外部复审模型对比：把合成样例（samples.mjs）逐例造成临时仓库，经外部复审适配器交给候选模型，按级别统计召回、误报、
// 格式一次通过率、注入是否带偏、只读副本是否不变、耗时与用量。业务含义：给“外部复审默认用哪个模型”提供实测依据。
// 会真实调用模型并把合成样例外发；只在用户授权后手动运行，不进 CI（文件名不是 *.test.mjs）。
// 用法：node evals/external-review/compare.mjs run --codebuddy <CodeBuddy CLI 入口> --models m1,m2 [--samples id,...] --out <仓库外目录>
//       node evals/external-review/compare.mjs prompts --out <目录>      写出每例的提示（宿主子代理对照组用同一份提示）
//       node evals/external-review/compare.mjs score --answers <JSON>     给对照组的回答判分（{ <样例id>: <审查 JSON> }）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrompt, buildRequest, DEFAULT_LIMITS, runExternalReview } from '../../components/engineering-kit/kit/gate/external-review.mjs';
import { SAMPLES, scoreSample } from './samples.mjs';

/** 在临时目录里运行 git（固定作者，不签名），失败时抛错。 */
function git(cwd, args) {
  const r = spawnSync('git', ['-c', 'user.name=eval', '-c', 'user.email=eval@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.excludesFile=', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr}`);
  return r.stdout.trim();
}

/** 写一组文件。 */
function writeFiles(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
}

/** 把一个样例造成临时仓库：main 上是基线和允许 codebuddy 的配置，feat 上是改动。返回 { root, base, head }。 */
export function sampleRepo(sample, parent) {
  const root = fs.mkdtempSync(path.join(parent, `${sample.id}-`));
  git(root, ['init', '-q', '-b', 'main']);
  const config = {
    base: 'main', sourceGlobs: ['src/**/*.mjs'], testGlobs: ['test/**/*.test.mjs'], reviewIgnore: ['**/*.md'], testCommand: 'node --test',
    reviewers: ['external:codebuddy'], reviewMinChars: 200, reviewKeyword: '结论', reviewFlow: 'pre-push', externalExecutors: ['codebuddy'],
  };
  writeFiles(root, { 'engineering.config.json': `${JSON.stringify(config, null, 2)}\n`, ...sample.base });
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'base']);
  const base = git(root, ['rev-parse', 'HEAD']);
  git(root, ['checkout', '-q', '-b', 'feat']);
  writeFiles(root, sample.head);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', sample.title]);
  return { root, base, head: git(root, ['rev-parse', 'HEAD']) };
}

/** 解析 --key value。 */
function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) o[argv[i].replace(/^--/, '')] = argv[i + 1];
  return o;
}

/** 选出要跑的样例。 */
const pick = (ids) => (ids ? SAMPLES.filter((s) => ids.split(',').includes(s.id)) : SAMPLES);

/** 用 CodeBuddy 跑一个模型的全部样例，返回逐例记录。 */
async function runModel({ model, samples, codebuddy, out }) {
  const local = { file: '(compare.mjs)', executors: { codebuddy: { type: 'codebuddy', command: [process.execPath, codebuddy], env: { CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1' } } } };
  const rows = [];
  for (const sample of samples) {
    const { root } = sampleRepo(sample, fs.mkdtempSync(path.join(os.tmpdir(), 'ek-xr-cmp-')));
    const runDir = path.join(out, model, sample.id);
    const started = Date.now();
    let res;
    try {
      res = await runExternalReview({ root, executor: 'codebuddy', model, modelChosenBy: 'user', modelReason: '模型对比评测', localConfig: local, outDir: runDir, limits: { timeoutMs: 10 * 60 * 1000, maxTurns: 20 } });
    } catch (e) {
      res = { ok: false, message: e.message, result: null, assessment: { reasons: [e.message] } };
    }
    const integrity = fs.existsSync(path.join(runDir, 'assessment.json')) ? JSON.parse(fs.readFileSync(path.join(runDir, 'assessment.json'), 'utf8')).integrity : null;
    const row = {
      model, sample: sample.id, ok: res.ok, verdict: res.assessment?.verdict ?? null,
      score: scoreSample(sample, res.result?.review),
      actualModel: res.result?.provenance?.actualModel ?? null, modelsUsed: res.result?.provenance?.modelsUsed ?? [],
      copyUnchanged: integrity?.copyUnchanged ?? null, repoUnchanged: integrity?.repoUnchanged ?? null,
      seconds: Math.round((Date.now() - started) / 1000), usage: res.result?.usage ?? null, reasons: res.assessment?.reasons ?? [], runDir,
    };
    rows.push(row);
    console.error(`[${model}] ${sample.id}: ok=${row.ok} verdict=${row.verdict} actual=${row.actualModel} ${row.seconds}s ${row.reasons.join('；')}`);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
  return rows;
}

/** 汇总一组逐例记录：按级别的召回与级别正确数、干净对照误报、格式一次通过、注入带偏、副本不变、耗时与积分。 */
export function summarize(rows) {
  const by = {};
  for (const r of rows) {
    const s = (by[r.model] ??= { model: r.model, recall: { high: [0, 0, 0], medium: [0, 0, 0], low: [0, 0, 0] }, cleanFp: null, format: [0, 0], misled: null, copyOk: [0, 0], seconds: 0, credits: 0, tokens: {} });
    for (const e of r.score.expected) {
      const c = s.recall[e.severity];
      c[1]++;
      if (e.detected) c[0]++;
      if (e.severityOk) c[2]++;
    }
    if (r.sample === 'clean') s.cleanFp = r.score.spurious;
    if (r.score.misled !== null) s.misled = r.score.misled;
    s.format[1]++;
    if (r.ok) s.format[0]++;
    if (r.copyUnchanged !== null) {
      s.copyOk[1]++;
      if (r.copyUnchanged && r.repoUnchanged) s.copyOk[0]++;
    }
    s.seconds += r.seconds;
    if (typeof r.usage?.credits === 'number') s.credits += r.usage.credits;
    for (const [k, v] of Object.entries(r.usage?.tokens ?? {})) if (typeof v === 'number') s.tokens[k] = (s.tokens[k] ?? 0) + v;
  }
  return Object.values(by);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = args(rest);
  if (cmd === 'run') {
    if (!a.codebuddy || !a.models || !a.out) throw new Error('run 需要 --codebuddy、--models、--out');
    const rows = [];
    for (const model of a.models.split(',')) rows.push(...(await runModel({ model, samples: pick(a.samples), codebuddy: a.codebuddy, out: path.resolve(a.out) })));
    fs.mkdirSync(a.out, { recursive: true });
    fs.writeFileSync(path.join(a.out, 'rows.json'), JSON.stringify(rows, null, 2));
    console.log(JSON.stringify(summarize(rows), null, 2));
  } else if (cmd === 'prompts') {
    fs.mkdirSync(a.out, { recursive: true });
    for (const sample of pick(a.samples)) {
      const { root, base, head } = sampleRepo(sample, fs.mkdtempSync(path.join(os.tmpdir(), 'ek-xr-cmp-')));
      const model = { id: 'host-control', source: 'request', chosenBy: 'user', reason: '对照组' };
      const { request } = buildRequest({ root, baseSha: base, headSha: head, kind: 'code', round: 'first', model, limits: DEFAULT_LIMITS });
      fs.writeFileSync(path.join(a.out, `${sample.id}.txt`), buildPrompt(request));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
    console.log(`已写出 ${pick(a.samples).length} 份提示到 ${a.out}`);
  } else if (cmd === 'score') {
    const answers = JSON.parse(fs.readFileSync(a.answers, 'utf8'));
    const rows = SAMPLES.filter((s) => answers[s.id]).map((s) => ({ model: a.model ?? 'control', sample: s.id, ok: true, score: scoreSample(s, answers[s.id]), copyUnchanged: null, seconds: 0, usage: null }));
    console.log(JSON.stringify({ rows, summary: summarize(rows) }, null, 2));
  } else {
    console.error('用法见文件头');
    process.exit(2);
  }
}
