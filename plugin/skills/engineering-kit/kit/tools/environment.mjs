// 环境选项：装套件时按用户的实际情况选执行位置，用户没选或不知道怎么选时按原则推荐。业务含义：
//   套件是公开分发的，每个用户的环境不同（系统、本机资源、有没有 GitHub、有没有服务器、用本地会话还是云端会话），
//   所以首次安装前先问清楚：全量测试在 CI 跑还是本机跑、CI 放哪、CI 跑在哪些系统、会话与并行偏好；选定后写进项目配置，
//   并生成对应的 CI 工作流。用户有想法的按用户的；用户没选或不知道怎么选时，按两条原则推荐：
//   一是本机的实际情况（系统、CPU、内存、有没有 GitHub 远程和 gh）；二是更快、更便宜、更高效、更准确
//   （能并行就并行；并行受资源限制时先想能不能放到云端，不行才串行；CI 只用 Linux 除非产品要在别的系统上运行）。
// 用法：node tools/environment.mjs detect [--target <项目>] [--choice <键=值>]…   输出本机事实与推荐（JSON），供 agent 问用户前核对
//   --choice 的键：fullTests、reviewFlow、ciRunner、ciFallback、ciOs（逗号分隔）、session、parallel，以及不写进配置的 hasServer（true/false）、targets（逗号分隔的系统）、requiredChecks（项目已有 CI 时写明哪些检查跑全量）、publicRepo（true/false，仓库是否公开；公开仓库不能用自托管 runner，有 GitHub 远程时会尽力自动读取，读到的结果优先，声明只在读不到时采信）。
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { CI_RUNNERS, DEFAULTS, FULL_TESTS, OS_NAMES, PARALLEL_MODES, REVIEW_FLOWS, SESSIONS, normalizeConfig } from '../gate/config.mjs';
import { git, isMain } from '../gate/lib.mjs';

/** 写进项目配置的环境取值键（--choice 里另有不写进配置的 hasServer、targets）。 */
export const VALUE_KEYS = ['fullTests', 'reviewFlow', 'ciRunner', 'ciFallback', 'ciOs', 'session', 'parallel'];

/** 汇总检查的名字：工作流里始终运行、全部通过才成功的 job；pr 流程把它列为必需检查，被跳过的测试 job 不会拦住合并。 */
export const CI_GATE_JOB = 'ci-gate';

/** 工作流相对路径。 */
export const CI_WORKFLOW_REL = '.github/workflows/ci.yml';

/**
 * 读本机事实：系统（linux/windows/macos）、CPU 数、内存 GB、项目是否有 GitHub 远程、gh 是否已登录（ghAvailable）。
 * override 用来注入（测试或用户已知的事实）。读不出的按“没有”处理，不抛错。
 */
export function detectFacts(root, override = {}) {
  const platform = { win32: 'windows', darwin: 'macos' }[process.platform] || 'linux';
  let githubRemote = false;
  if (root) {
    const r = git(root, ['remote', 'get-url', 'origin']);
    githubRemote = r.ok && /github\.com/i.test(r.out);
  }
  // 能用 gh 访问 GitHub 才算可用：只装了 gh、没登录不能建仓库、开 PR。用 gh api user 而不是 gh auth status：
  // 后者会因为另一个过期的账号返回非零，而当前账号其实可用
  const gh = spawnSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8' });
  // 仓库公开与否（有 GitHub 远程时尽力读，读不到是 null）：公开仓库不能用自托管 runner
  let repoPublic = null;
  if (root && githubRemote && gh.status === 0) {
    const v = spawnSync('gh', ['repo', 'view', '--json', 'isPrivate', '--jq', '.isPrivate'], { cwd: root, encoding: 'utf8' });
    if (v.status === 0) repoPublic = v.stdout.trim() === 'false' ? true : v.stdout.trim() === 'true' ? false : null;
  }
  return {
    os: platform,
    cpus: os.cpus().length,
    memGB: Math.round(os.totalmem() / 2 ** 30),
    githubRemote,
    ghAvailable: gh.status === 0,
    repoPublic,
    ...override,
  };
}

/** 本机资源紧张：CPU 不超过 4 核或内存不超过 8 GB（全量测试和并行任务在本机会明显卡）。 */
const isConstrained = (facts) => facts.cpus <= 4 || facts.memGB <= 8;

/**
 * 推荐：返回 { values, reasons, sources, conflicts }。choices 里用户给出的项一律优先（sources 记 user），没给的按原则推荐（recommended）。
 * choices 除配置键外还可带 hasServer（用户有没有自己的服务器可作自托管 runner）和 targets（产品要运行的系统，影响 CI 系统）。
 * 冲突只列出、不静默改：fullTests=ci 配 pre-push 流程、ci 却没有 CI、没有服务器却选自托管。
 */
export function recommend(facts, choices = {}) {
  const values = {};
  const reasons = {};
  const sources = {};
  const conflicts = [];
  const pick = (key, chosen, rec, reason) => {
    if (chosen !== undefined) {
      values[key] = chosen;
      sources[key] = 'user';
      reasons[key] = '用户选择';
    } else {
      values[key] = rec;
      sources[key] = 'recommended';
      reasons[key] = reason;
    }
  };
  const tight = isConstrained(facts);
  const hasGithub = facts.githubRemote || facts.ghAvailable;

  pick('fullTests', choices.fullTests, hasGithub ? 'ci' : 'local', hasGithub
    ? '有 GitHub：交给 CI 更快（云端并行，不占本机）、更便宜（公开仓库免费，私有仓库有免费额度）、更准确（干净环境），本机只做静态检查；还没有 GitHub 远程的先建仓库再推送'
    : '没有 GitHub 远程也没有 gh：CI 暂时不可用，全量在会话所在环境跑；有了 GitHub 后再改成 ci');
  pick('reviewFlow', choices.reviewFlow, values.fullTests === 'ci' ? 'pr' : 'pre-push', values.fullTests === 'ci'
    ? '全量交给 CI 时要用 pr 流程：只有它的合并入口核对 CI 在最终提交上全部通过'
    : '没有 CI 核对时用 pre-push 流程：推送前复审，推送核对要求全量测试记录');
  const wantCi = values.fullTests === 'ci';
  pick('ciRunner', choices.ciRunner, wantCi ? 'github-hosted' : null, wantCi
    ? 'GitHub 托管 runner 免维护、公开仓库免费，额度够用时最省事；有服务器的另设后备'
    : '全量不交给 CI，CI 放哪暂不声明');
  const runner = values.ciRunner;
  const publicRepo = repoPublicOf(facts, choices);
  // 公开仓库不推荐自托管 runner：外部 PR 能改工作流，在用户服务器上执行任意代码
  const fallbackRec = choices.hasServer === true && publicRepo === false && (runner === 'github-hosted' || runner === 'self-hosted') ? (runner === 'github-hosted' ? 'self-hosted' : 'github-hosted') : null;
  pick('ciFallback', choices.ciFallback, fallbackRec, fallbackRec ? '有自己的服务器：主 CI 额度用完或不可用时改用另一处，不耽误合并' : publicRepo !== false && choices.hasServer === true ? '仓库是公开的或可见性未知（无法确认是私有）：不设自托管后备，外部 PR 能改工作流，会在你的服务器上执行任意代码；确认是私有仓库后用 publicRepo=false 再试' : '没有服务器，不设后备');
  const extra = [...new Set((choices.targets || []).filter((t) => OS_NAMES.includes(t) && t !== 'linux'))];
  pick('ciOs', choices.ciOs, ['linux', ...extra], extra.length > 0
    ? `产品要在 ${extra.join('、')} 上运行：除 Linux 外也在这些系统上验证（更准确），但 Windows 按 2 倍、macOS 按 10 倍计费`
    : '只用 Linux：最快、最便宜（Windows 按 2 倍、macOS 按 10 倍计费）；产品要在别的系统上运行时再加');
  pick('session', choices.session, tight ? 'cloud' : 'local', tight
    ? '本机资源紧张（CPU 或内存偏低）：开发里耗资源的重复性工作放云端会话更快，不占本机（启动云端会话有费用，开工前先问你）'
    : '本机资源够用：本地会话不额外花钱，环境也与你日常一致');
  const serialNeeded = tight && values.session === 'local' && values.fullTests === 'local';
  pick('parallel', choices.parallel, serialNeeded ? 'serial' : 'parallel', serialNeeded
    ? '本机资源紧张又要在本机跑全量，并行会互相抢资源：串行；能放云端会话或交给 CI 时就可以并行'
    : '能并行的并行（更快）；资源受限的部分放到云端会话或 CI 上跑');

  if (values.fullTests === 'ci' && values.reviewFlow !== 'pr') conflicts.push('fullTests 为 ci 须搭配 pr 流程（只有 pr 流程的合并入口核对 CI）');
  if (values.fullTests === 'ci' && (values.ciRunner === null || values.ciRunner === 'none')) conflicts.push('fullTests 为 ci 须声明 ciRunner 为 github-hosted 或 self-hosted（ciRunner 不能是 none 或不写）');
  conflicts.push(...serverConflicts(values, choices, facts));
  conflicts.push(...ghConflicts(values, facts));
  // 与安装时的配置校验同一口径：detect 阶段就把安装会报的错列出来（只在没有别的冲突时补，避免重复）
  if (conflicts.length === 0) {
    try {
      normalizeConfig(applyEnvironment({ profile: 2 }, values, { requiredChecks: choices.requiredChecks ?? (values.fullTests === 'ci' ? [CI_GATE_JOB] : undefined) }));
    } catch (e) {
      conflicts.push(e.message);
    }
  }
  return { values, reasons, sources, conflicts };
}

/**
 * 自托管 runner 的冲突：没有自己的服务器（hasServer 不是 true，没声明也算——须明确确认）；
 * 仓库不是确认的私有（公开，或可见性读不出来）：外部 PR 能改工作流，在用户服务器上执行任意代码，工作流里的 fork 分流不是安全边界。主用或后备都查；
 * 读不出可见性时（没有 GitHub 远程、gh 没登录）按公开处理，用户确认私有后用 publicRepo=false；探测到的结果优先于声明。
 */
function serverConflicts(values, choices, facts = {}) {
  const selfKeys = ['ciRunner', 'ciFallback'].filter((k) => values[k] === 'self-hosted');
  const out = [];
  if (choices.hasServer !== true) out.push(...selfKeys.map((k) => `${k} 选了自托管 runner，但没有确认有自己的服务器（用 hasServer=true 明确确认）：改选 github-hosted，或先准备服务器`));
  const isPublic = repoPublicOf(facts, choices);
  if (isPublic === true) out.push(...selfKeys.map((k) => `${k} 选了自托管 runner，但仓库是公开的：外部 PR 能改工作流并在你的服务器上执行任意代码，公开仓库请用 github-hosted`));
  else if (isPublic !== false) out.push(...selfKeys.map((k) => `${k} 选了自托管 runner，但无法确认仓库是私有的（可见性未知）：外部 PR 能改工作流并在你的服务器上执行任意代码；确认是私有仓库后用 publicRepo=false，否则用 github-hosted`));
  return out;
}

/**
 * 仓库是否公开：true / false / null（未知）。任一来源说公开就按公开（保守）；声明私有只在探测不到时采信，不能把探测到的公开仓库声明成私有。
 */
function repoPublicOf(facts = {}, choices = {}) {
  if (facts.repoPublic === true || choices.publicRepo === true) return true;
  return facts.repoPublic ?? choices.publicRepo ?? null;
}

/** ci 与 pr 流程的复审登记、合并、查 CI 都走 gh：gh 没登录时安装能成功、后面会卡住，所以对最终选定的取值统一检查（推荐与只给选择两种模式共用）。 */
function ghConflicts(values, facts = {}) {
  if ((values.fullTests === 'ci' || values.reviewFlow === 'pr') && facts.ghAvailable === false) {
    return ['fullTests 为 ci 或 reviewFlow 为 pr 都要用 gh（登记复审、查 CI、合并）：gh 未登录，先运行 gh auth login，或改用 pre-push 流程且全量在本机跑'];
  }
  return [];
}

/** 一句话说明命令写法：按本机系统。 */
const SHELL_NOTE = {
  windows: '本机是 Windows：命令按 PowerShell 写法（路径含空格要加引号，不用 bash 专有语法）',
  macos: '本机是 macOS：命令按 zsh/bash 的 shell 写法',
  linux: '本机是 Linux：命令按 bash 的 shell 写法',
};

/** 把选定的执行方式写成几行中文说明（装完时给用户核对，也让 agent 知道每种选择对应怎么做）。 */
export function describeEnvironment(values, facts) {
  const lines = [`本机系统与资源：${SHELL_NOTE[facts.os] || facts.os}；CPU ${facts.cpus} 核、内存约 ${facts.memGB} GB`];
  lines.push(values.fullTests === 'ci'
    ? `全量测试：交给 CI（${values.ciRunner}${values.ciFallback ? `，后备 ${values.ciFallback}` : ''}）。闸门只做静态检查，推送后 CI 在最终提交上跑，pr 流程的合并入口核对通过；本机不跑全量`
    : '全量测试：在会话所在环境（本地会话在本机，云端会话在云端沙箱）由闸门跑，写测试记录');
  lines.push(`CI 系统：${(values.ciOs || DEFAULTS.ciOs).join('、')}${values.ciFallback === 'self-hosted' || values.ciRunner === 'self-hosted' ? '；自托管 runner 只用于 Linux，切换用仓库变量 CI_RUNNER，不用改工作流' : ''}`);
  lines.push(values.session === 'cloud'
    ? '会话：开发和重复性工作优先放云端会话（不占本机资源；启动云端会话有费用，开工前先问用户）'
    : values.session === 'local'
      ? '会话：优先本地会话（不额外花钱）；本机装不下的重复性工作再问用户要不要放云端'
      : '会话：未声明，agent 按“更快、更便宜、更高效、更准确”和本机实际情况选，有多种可行时问用户');
  lines.push(values.parallel === 'serial'
    ? '并行：串行（本机资源受限）；能放云端会话或 CI 的部分可以并行'
    : values.parallel === 'parallel'
      ? '并行：能并行的并行；资源受限时先想放云端，不行才串行'
      : '并行：未声明，agent 默认能并行就并行，资源受限时放云端或串行');
  return lines;
}

/** 复制并按选定的取值改写 profile 配置（不改入参）。requiredChecks 只在给出时写入。 */
export function applyEnvironment(profile, values, { requiredChecks = values.requiredChecks } = {}) {
  const out = JSON.parse(JSON.stringify(profile));
  out.modules = out.modules || {};
  const gate = { ...(out.modules.gate || {}) };
  for (const k of ['fullTests', 'reviewFlow', 'ciRunner', 'ciFallback']) {
    if (values[k] !== undefined && values[k] !== null) gate[k] = values[k];
  }
  if (requiredChecks) gate.requiredChecks = requiredChecks;
  out.modules.gate = gate;
  const env = { ...(out.modules.environment || {}) };
  for (const k of ['ciOs', 'session', 'parallel']) {
    if (values[k] !== undefined && values[k] !== null) env[k] = values[k];
  }
  if (Object.keys(env).length > 0) out.modules.environment = env;
  return out;
}

/**
 * 把用户的选择解析成要写进配置的取值：recommended 为 true 时没选的项按推荐补全，为 false 时只写用户给出的项。
 * 取值不合法或组合不成立（例如 ci 配 pre-push）时抛错，不写出一份必然报错的配置。facts 默认现读。
 */
export function resolveEnvironment(root, { recommended = false, choices = {} } = {}, facts = detectFacts(root)) {
  const recommendation = recommend(facts, choices);
  if (recommended && recommendation.conflicts.length > 0) throw new Error(`环境选择有冲突：${recommendation.conflicts.join('；')}`);
  const values = recommended ? { ...recommendation.values } : Object.fromEntries(VALUE_KEYS.filter((k) => choices[k] !== undefined).map((k) => [k, choices[k]]));
  // 只写用户给出的项时不拿推荐值制造冲突，只核对用户自己选的；推荐模式的冲突上面已拦
  const own = [...serverConflicts(values, choices, facts), ...ghConflicts(values, facts)];
  if (own.length > 0) throw new Error(`环境选择有冲突：${own.join('；')}`);
  // 已有 CI 时由用户写明哪些检查跑全量（requiredChecks）：不属于推荐，原样带上
  if (choices.requiredChecks !== undefined) values.requiredChecks = choices.requiredChecks;
  // 取值与组合不成立时在这里抛错；套件生成工作流时必需检查是 ci-gate，先按它校验（已有 ci.yml 的项目由 sync 另查 requiredChecks）
  normalizeConfig(applyEnvironment({ profile: 2 }, values, { requiredChecks: values.requiredChecks ?? (values.fullTests === 'ci' ? [CI_GATE_JOB] : undefined) }));
  return { values, facts, recommendation };
}

/**
 * 工作流里 Linux 的 runner：只有一处时直接写；有后备时用仓库变量 CI_RUNNER 切换（不用改工作流、不用提交）。
 * 自托管 runner 带 [self-hosted, linux] 两个标签，不会被同一仓库注册的 Windows、macOS 自托管机接走；
 * 来源仓库不是本仓库的 PR（fork）走 GitHub 托管 runner，外部提交的代码不在用户自己的服务器上执行。
 * 这只是第二道防线，不是安全边界：PR 能改工作流本身，真正的隔离靠不在接受外部 PR 的公开仓库用自托管 runner（resolveEnvironment 对公开仓库直接拒绝）。
 */
function linuxRunner({ ciRunner, ciFallback }) {
  const self = `fromJSON('["self-hosted","linux"]')`;
  const external = "(github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository)";
  if (ciRunner === 'self-hosted') {
    return ciFallback === 'github-hosted'
      ? `\${{ (vars.CI_RUNNER == 'github-hosted' || ${external}) && 'ubuntu-latest' || ${self} }}`
      : `\${{ ${external} && 'ubuntu-latest' || ${self} }}`;
  }
  return ciFallback === 'self-hosted' ? `\${{ vars.CI_RUNNER == 'self-hosted' && !${external} && ${self} || 'ubuntu-latest' }}` : 'ubuntu-latest';
}

/** 总是算“有代码改动”的路径（与闸门同口径：项目配置、豁免表、套件脚本永远在范围内，不当文档）。 */
const ALWAYS_CODE = ['engineering.config.json', 'scripts/engineering/**'];

/** YAML 单引号字符串里的单引号写成两个。 */
const yamlSingle = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** 按测试命令判断运行环境：npm、node 用 Node，python、pytest 用 Python，其余不装。 */
function stackSetup(testCommand) {
  if (/^\s*(npm|npx|node|pnpm|yarn)\b/.test(testCommand)) {
    return "      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6\n        with:\n          node-version: '24'\n";
  }
  if (/^\s*(python|pytest|py)\b/.test(testCommand)) {
    return "      - uses: actions/setup-python@v5\n        with:\n          python-version: '3.12'\n      - run: python -m pip install pytest\n";
  }
  return '';
}

/**
 * 生成 CI 工作流（GitHub Actions）。业务含义：把“降低 CI 频率”和“全量测试交给 CI”落成一份可用的工作流——
 * 草稿 PR 不跑（转为可审阅时才跑）；只改免审文档（reviewIgnore）的 PR 跳过测试，但汇总检查 ci-gate 仍成功，
 * 所以 pr 流程的合并入口不会因为必需检查被跳过而拦住；同一 PR 的新提交取消上一次未完成的运行；推送到 main 总是全量。
 * 参数：ciRunner、ciFallback、ciOs、testCommand、reviewIgnore。生成后由项目维护，同步不覆盖。
 */
export function renderCiWorkflow({ ciRunner, ciFallback = null, ciOs = ['linux'], testCommand, testEnv = {}, reviewIgnore = [] }) {
  const linux = linuxRunner({ ciRunner, ciFallback });
  const matrix = ciOs
    .map((o) => `          - os: ${o}\n            runner: ${o === 'linux' ? linux : o === 'windows' ? 'windows-latest' : 'macos-latest'}`)
    .join('\n');
  // 是否只改文档：用 Node 的 path.matchesGlob 判断，与闸门同一套 glob 语义（docs/*.md 不匹配 docs/a/b.md）；
  // 路径用 -z 输出（中文路径不被转义），改名按旧路径删除加新路径新增算（--no-renames）；差异为空按含代码处理。
  const detect = reviewIgnore.length === 0
    ? '          echo "code=true" >> "$GITHUB_OUTPUT"\n'
    : [
        '          if [ "$EVENT" != "pull_request" ]; then echo "code=true" >> "$GITHUB_OUTPUT"; exit 0; fi',
        '          git -c core.quotepath=false diff --no-renames --name-only -z "$BASE_SHA" HEAD > "$RUNNER_TEMP/changed.txt"',
        `          node -e "const { matchesGlob } = require('node:path'); const files = require('node:fs').readFileSync(process.env.RUNNER_TEMP + '/changed.txt', 'utf8').split('\\\\0').filter(Boolean); const ignore = JSON.parse(process.env.IGNORE); const always = JSON.parse(process.env.ALWAYS); const doc = (f) => !always.some((g) => matchesGlob(f, g)) && ignore.some((g) => matchesGlob(f, g)); console.log('code=' + (files.length === 0 || files.some((f) => !doc(f))));" >> "$GITHUB_OUTPUT"`,
        '',
      ].join('\n');
  const envBlock = reviewIgnore.length === 0 ? '' : `          IGNORE: ${yamlSingle(JSON.stringify(reviewIgnore))}\n          ALWAYS: ${yamlSingle(JSON.stringify(ALWAYS_CODE))}\n`;
  const testEnvBlock = Object.keys(testEnv).length === 0 ? '' : `        env:\n${Object.entries(testEnv).map(([k, v]) => `          ${k}: ${JSON.stringify(String(v))}`).join('\n')}\n`;
  return `# 由 engineering-kit 按项目选定的执行位置生成（modules.gate.fullTests、ciRunner、modules.environment.ciOs）；生成后由项目维护，同步不覆盖。
# 降低 CI 频率：草稿 PR 不跑；只改免审文档（reviewIgnore）的 PR 跳过测试，汇总检查 ${CI_GATE_JOB} 仍成功；同一 PR 的新提交取消上一次未完成的运行。
${ciFallback ? `# 后备切换：在仓库设置里把变量 CI_RUNNER 设成 ${ciFallback}（改回删除变量或设成 ${ciRunner}），不用改本文件。自托管 runner 只用于 Linux，带 self-hosted、linux 标签。\n` : ''}${ciRunner === 'self-hosted' || ciFallback === 'self-hosted' ? '# 安全：不要把自托管 runner 用在接受外部 PR 的公开仓库；这里让 fork 来的 PR 走 GitHub 托管 runner 只是第二道防线（PR 能改工作流本身），不是安全边界；公开仓库请不要用自托管 runner。testCommand 与 testEnv 是安装时写入的，之后改了它们要同步改本文件。\n' : ''}name: CI

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: ci-\${{ github.event.pull_request.number || github.run_id }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}

jobs:
  changes:
    name: changes
    if: github.event.pull_request.draft != true
    runs-on: ${linux}
    outputs:
      code: \${{ steps.diff.outputs.code }}
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
        with:
          persist-credentials: false
          fetch-depth: 0
      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6
        with:
          node-version: '24'
      - id: diff
        env:
          EVENT: \${{ github.event_name }}
          BASE_SHA: \${{ github.event.pull_request.base.sha }}
${envBlock}        run: |
${detect}
  test:
    name: test (\${{ matrix.os }})
    needs: changes
    if: needs.changes.outputs.code == 'true'
    runs-on: \${{ matrix.runner }}
    strategy:
      fail-fast: false
      matrix:
        include:
${matrix}
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
        with:
          persist-credentials: false
${stackSetup(testCommand)}      - run: ${testCommand}
${testEnvBlock}
  ${CI_GATE_JOB}:
    name: ${CI_GATE_JOB}
    needs: [changes, test]
    if: always() && github.event.pull_request.draft != true
    runs-on: ${linux}
    steps:
      - env:
          CHANGES: \${{ needs.changes.result }}
          TEST: \${{ needs.test.result }}
          CODE: \${{ needs.changes.outputs.code }}
        run: |
          [ "$CHANGES" = success ] || { echo "changes: $CHANGES"; exit 1; }
          if [ "$CODE" = true ]; then
            [ "$TEST" = success ] || { echo "test: $TEST"; exit 1; }
          else
            echo "只改免审文档：测试已跳过"
          fi
`;
}

/** 解析 --choice 的一项（键=值）：校验键与取值，hasServer 为布尔，targets 与 ciOs 为逗号分隔列表。 */
export function parseChoice(text) {
  const i = text.indexOf('=');
  if (i < 0) throw new Error(`--choice 要写成 键=值（收到 ${text}）`);
  const key = text.slice(0, i);
  const val = text.slice(i + 1);
  const oneOf = (list) => {
    if (!list.includes(val)) throw new Error(`${key} 只能是 ${list.join('、')}（收到 ${val}）`);
    return val;
  };
  const list = (allowed) => {
    const items = val.split(',').map((x) => x.trim()).filter(Boolean);
    const bad = items.find((x) => !allowed.includes(x));
    if (items.length === 0 || bad) throw new Error(`${key} 取值只能是 ${allowed.join('、')}，逗号分隔（收到 ${val}）`);
    return items;
  };
  switch (key) {
    case 'fullTests': return [key, oneOf(FULL_TESTS)];
    case 'reviewFlow': return [key, oneOf(REVIEW_FLOWS)];
    case 'ciRunner': return [key, oneOf(CI_RUNNERS)];
    case 'ciFallback': return [key, oneOf(CI_RUNNERS.filter((r) => r !== 'none'))];
    case 'session': return [key, oneOf(SESSIONS)];
    case 'parallel': return [key, oneOf(PARALLEL_MODES)];
    case 'ciOs': return [key, list(OS_NAMES)];
    case 'targets': return [key, list(OS_NAMES)];
    case 'hasServer': return [key, oneOf(['true', 'false']) === 'true'];
    case 'publicRepo': return [key, oneOf(['true', 'false']) === 'true'];
    case 'requiredChecks': return [key, val.split(',').map((x) => x.trim()).filter(Boolean)];
    default: throw new Error(`未知的 --choice 键 ${key}`);
  }
}

/** 把若干 --choice 文本合成对象。 */
export function parseChoices(list) {
  return Object.fromEntries(list.map(parseChoice));
}

if (isMain(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    if (argv[0] !== 'detect') {
      console.error('用法：node environment.mjs detect [--target <项目>] [--choice <键=值>]…');
      process.exit(2);
    }
    const choices = [];
    let target = process.cwd();
    for (let i = 1; i < argv.length; i += 1) {
      if (argv[i] === '--target') target = path.resolve(argv[++i]);
      else if (argv[i] === '--choice') choices.push(argv[++i]);
    }
    const facts = detectFacts(target);
    const recommendation = recommend(facts, parseChoices(choices));
    console.log(JSON.stringify({ facts, recommendation, description: describeEnvironment(recommendation.values, facts) }, null, 2));
  } catch (e) {
    console.error(`环境检测失败：${e.message}`);
    process.exit(1);
  }
}
