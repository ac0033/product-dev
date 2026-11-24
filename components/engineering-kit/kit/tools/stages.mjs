// 环节表：每个环节里的每项工作在哪做、为什么、谁定的。业务含义：
//   同一个任务要经过推送前（A）、PR 阶段（B）、合并与收尾（C）、每周巡检（W）几个环节，每个环节里有些工作只能在某处做，
//   有些在本机、云端会话、自己的服务器都行。决定顺序固定为：
//     1. 用户的选择（对具体工作的指定，或项目选项 modules.environment.session——装套件时用户选的，或用户接受了推荐的）；
//     2. 用户没选时按两条原则自动判断：本机的实际情况（资源紧不紧、有没有服务器），以及更快、更便宜、更高效、更准确；
//     3. 多种做法都可行、两条原则指向不同（例如云端更快但要花钱、本机更省但慢）时，问用户，列出可选项和各自代价。
//   发布与发布后验收（D、E）不在这里：它们是各项目自己的流程，本仓库的见 docs/release/README.md。
// 用法：node tools/stages.mjs --stage A|B|C|W [--target <项目>] [--choice <键=值>]…   输出该环节的决定（JSON）
//   --choice 的键：hasServer（true/false：有自己的服务器且 runner 在线）、externalExecutor（true/false：配了外部执行器）、
//   tight（true/false：本机资源紧张，不写则按本机 CPU 和内存探测）、以及对具体工作的指定“工作编号=local-session|cloud-session|server”。
//   项目配置优先取基准提交上生效的策略字段（与闸门一致），读不到时取工作区文件，输出里的 configSource 标明来源。
import fs from 'node:fs';
import path from 'node:path';
import { normalizeConfig } from '../gate/config.mjs';
import { EMPTY_TREE, baseRevision, git, isMain, loadConfig } from '../gate/lib.mjs';
import { applyEnvironment, detectFacts, isConstrained } from './environment.mjs';

export const STAGE_IDS = ['A', 'B', 'C', 'W'];
const LOCAL = 'local-session';
const CLOUD = 'cloud-session';
const SERVER = 'server';
const PLACES = [LOCAL, CLOUD, SERVER];

/** 三个去处的特点（越大越好）：便宜、快、省事（步骤少）。本机资源紧张时本机慢；云端要花钱；服务器要用户已有。 */
function traits(tight) {
  return {
    [LOCAL]: { cheap: 1, fast: tight ? 0 : 1, easy: 2 },
    [SERVER]: { cheap: 1, fast: 1, easy: 1 },
    [CLOUD]: { cheap: 0, fast: 1, easy: 0 },
  };
}

const COST = {
  [LOCAL]: '本机：不花钱，但占用本机资源',
  [CLOUD]: '云端会话：不占本机，但启动有费用（按 R2 先问）',
  [SERVER]: '自己的服务器：不花钱、不占本机，需要服务器和 runner 在线',
};

/** 按两条原则从可行的去处里选：有一个在“便宜、快”上不输给其他、且至少一项更好就选它；并列时取省事的（与列出的先后无关）；否则返回 null（要问用户）。 */
export function byPrinciples(feasible, tight) {
  const t = traits(tight);
  const better = (a, b) => t[a].cheap >= t[b].cheap && t[a].fast >= t[b].fast && (t[a].cheap > t[b].cheap || t[a].fast > t[b].fast);
  const front = feasible.filter((a) => !feasible.some((b) => b !== a && better(b, a)));
  if (front.length === 1) return front[0];
  const same = front.every((a) => t[a].cheap === t[front[0]].cheap && t[a].fast === t[front[0]].fast);
  if (!same) return null;
  return [...front].sort((a, b) => t[b].easy - t[a].easy)[0];
}

/**
 * doc、docWhere：process.md 环节表里这项工作那一行的“工作”栏原文和“去处”栏必须含的关键词；
 * must：关键短语，必须同时出现在代码给出的理由和文档那一行的“去处”栏里。一致性测试逐行核对，文档与代码不再各改各的。
 */
const fixed = (id, label, where, reason, doc, docWhere, must = []) => ({ id, label, kind: 'fixed', where, reason, doc, docWhere, must });
/** serverCapable：这项工作原则上能放在自己的服务器上（还要 hasServer 确认才算可行）；全量测试、本机的工作不能。 */
const choice = (id, label, feasible, reason, serverCapable, doc, docWhere, must = []) => ({ id, label, kind: 'choice', feasible, reason, serverCapable, doc, docWhere, must });
const reviewWhere = (env) => (env.externalExecutor ? 'executor-machine' : 'current-session');
const REVIEW_REASON = (env) => (env.externalExecutor
  ? '外部执行器（如 Codex）的命令和模型写在仓库之外的本机配置，只能在配了它的机器上跑；理论上可以迁到服务器，但 Linux 上只读沙箱、无工具等行为未验证，须先测试再迁，目前不实现'
  : '由宿主子代理或用户另开的全新会话做，不共享作者上下文');

/** 每个环节有哪些工作（随项目配置增减；env 已经过校验和补全）。 */
const STAGES = {
  A: {
    name: '推送前',
    items: (env) => [
      fixed('static', '静态检查（闸门）', 'current-session', '快、不占额外资源，推送前必须过（R4）', '静态检查、受影响测试', '当前会话'),
      fixed('affected', '受影响测试', 'current-session', '只跑受影响的分组，本机或云端会话都很快，推送前必须过', '静态检查、受影响测试', '当前会话'),
      ...(env.fullTests === 'local' ? [choice('full-tests-local', '全量测试（fullTests=local）', [LOCAL, CLOUD], '全量测试耗时长、占资源，在会话所在环境由闸门跑并写测试记录', false, '全量测试（`fullTests=local`）', '本机或云端会话')] : []),
      ...(env.reviewFlow === 'pre-push'
        ? [
          fixed('independent-reviews', '独立代码复审与一致性审（pre-push 流程，推送前做）', reviewWhere(env), REVIEW_REASON(env), '独立复审（仅 `pre-push` 流程，推送前做）', '外部执行器', ['外部执行器']),
          fixed('review-record', '复审登记（pre-push 流程）', 'same-worktree', '复审记录写在该工作树自己的 git 目录里，同一仓库的不同工作树、不同副本都不共享，所以复审、登记、推送要在同一个工作树里做完', '复审登记（仅 `pre-push` 流程）', '工作树', ['工作树']),
        ]
        : []),
    ],
  },
  B: {
    name: 'PR 阶段',
    items: (env) => [
      ...(env.fullTests === 'ci' ? [ciItem(env)] : []),
      ...(env.reviewFlow === 'pr'
        ? [
          fixed('independent-reviews', '独立代码复审与一致性审（pr 流程，可与 CI 并行开始）', reviewWhere(env), REVIEW_REASON(env), '独立复审（仅 `pr` 流程，可与 CI 并行开始）', '外部执行器', ['外部执行器']),
          fixed('review-register', '登记审查记录（CI 全部通过后）', 'same-copy', 'PR 审查记录放在 git 公共目录，同一仓库副本的各工作树共享，不跨副本，所以要在合并入口所在的那个副本里登记', '登记审查记录（仅 `pr` 流程，CI 全部通过后）', '合并入口所在的仓库副本', ['不跨副本']),
        ]
        : []),
      fixed('fix-findings', '处理复审意见、修复失败', 'current-session', '创造性工作，需要判断，排在用户在场的时段', '处理复审意见、修复失败', '当前会话'),
    ],
  },
  C: {
    name: '合并与收尾',
    items: (env) => [
      env.reviewFlow === 'pr'
        ? fixed('merge-entry', '合并入口（核对 CI 与审查记录）', 'same-copy', '审查记录不跨副本共享，要在登记它的同一个仓库副本里合并；合并要用户授权（R2）', '合并入口（`pr` 流程）', '同一个仓库副本', ['用户授权'])
        : mergePrePush(env),
      fixed('cleanup', '删除分支、清理工作树', 'current-session', '合并后立即做，汇报“完成”前确认已清理', '删除分支、清理工作树、汇报', '当前会话'),
      fixed('wrap-up', '汇报与经验提炼', 'current-session', '需要判断和用户沟通，不外包', '删除分支、清理工作树、汇报', '当前会话'),
    ],
  },
  W: {
    name: '每周巡检',
    items: (env) => [choice('weekly-inspection', '每周巡检（重复性工作）', env.hasServer === true ? [LOCAL, CLOUD, SERVER] : [LOCAL, CLOUD], '不需要人参与的重复性工作，攒成整块在用户离开后跑，尽量不占本机', true, '巡检（重复性工作）', '本机、云端会话或服务器')],
  },
};

const CI_DOC = '全量测试（`fullTests=ci`）';

/**
 * pre-push 流程的合并：有 CI（包括没声明、按可能有处理）要等 PR 的 CI 全部通过；ciRunner 为 none（没有 CI）时没有可等的，只剩按项目约定合并和用户授权。
 * 复审与测试记录只证明推送前的状态这一条，两种情况都成立。
 */
function mergePrePush(env) {
  const label = '合并（pre-push 流程没有合并入口脚本）';
  const doc = '合并（`pre-push` 流程没有合并入口脚本）';
  if (env.ciRunner === 'none') {
    return fixed('merge', label, 'current-session', '项目没有 CI（ciRunner=none），没有 CI 可等：按项目约定合并，合并要用户授权（R2），不绕过失败的检查；复审与测试记录只证明推送前的状态，不能证明对 PR 最终提交的双审', doc, 'CI 全部通过', ['用户授权', '不绕过失败的检查']);
  }
  return fixed('merge', label, 'current-session', '按项目约定合并，合并要用户授权（R2）；等 PR 的 CI 全部通过（不只是必需检查），不绕过失败的检查；复审与测试记录只证明推送前的状态，不能证明对 PR 最终提交的双审', doc, 'CI 全部通过', ['CI 全部通过', '用户授权', '不绕过失败的检查']);
}

/** B 环节的 CI 全量测试：按项目选项落到托管或服务器；配了自托管却明确没有服务器时转问用户。 */
function ciItem(env) {
  const label = '全量测试（CI）';
  const note = '本命令读不到仓库变量 CI_RUNNER：若已用它切换了 Linux 的 runner，以实际为准；Windows、macOS 矩阵项始终在 GitHub 托管 runner 上跑';
  if (env.ciRunner === 'self-hosted' && env.hasServer === false) {
    return { id: 'ci-full-tests', label, kind: 'ask', doc: CI_DOC, docWhere: 'CI', must: ['CI_RUNNER'], options: ['server', 'github-hosted'], reason: `项目选项 ciRunner=self-hosted，但你说没有可用的服务器：请选改用 github-hosted，或先准备好服务器和 runner。${note}` };
  }
  return {
    id: 'ci-full-tests', label, kind: 'config', doc: CI_DOC, docWhere: 'CI', must: ['CI_RUNNER'], where: env.ciRunner === 'self-hosted' ? SERVER : 'github-hosted',
    reason: `按项目选项 fullTests=ci、ciRunner=${env.ciRunner}${env.ciFallback ? `，后备 ${env.ciFallback}（切换用仓库变量 CI_RUNNER）` : ''}；CI 在最终提交上跑，合并入口核对。${note}`,
  };
}

/** 环节表在 process.md 里应有的行：每个环节的每项工作一行（同一行的工作合并），含工作栏原文、去处栏关键词、谁定栏。一致性测试据此核对文档。 */
export function docRows() {
  const rows = new Map();
  const envs = [
    { fullTests: 'local', reviewFlow: 'pre-push', externalExecutor: true, hasServer: true },
    { fullTests: 'ci', reviewFlow: 'pr', ciRunner: 'github-hosted', externalExecutor: true, hasServer: true },
  ];
  for (const env of envs) {
    const e = normalizeEnv(env);
    for (const stage of STAGE_IDS) {
      for (const spec of STAGES[stage].items(e)) {
        const key = `${stage}|${spec.doc}`;
        const who = spec.kind === 'choice' ? '按上面三步' : spec.kind === 'config' ? '项目选项' : '不用选';
        if (!rows.has(key)) rows.set(key, { stage, stageName: STAGES[stage].name, doc: spec.doc, docWhere: spec.docWhere, who, ids: [], must: [] });
        const row = rows.get(key);
        if (!row.ids.includes(spec.id)) row.ids.push(spec.id);
        for (const m of spec.must ?? []) if (!row.must.includes(m)) row.must.push(m);
      }
    }
  }
  return [...rows.values()];
}

const DEFAULTS = { fullTests: 'local', ciRunner: null, ciFallback: null, reviewFlow: 'pre-push', session: null, hasServer: undefined, tight: false, externalExecutor: false };

/**
 * 补全默认值并严格校验：undefined 当作没给，其余取值不对就报错，不静默当成别的意思。
 * 配置字段（fullTests、reviewFlow、ciRunner、ciFallback、session）及其组合直接复用项目配置的校验（normalizeConfig，闸门用的同一份规则），
 * 不在这里再写一份：ci 须搭 pr 流程和已声明的 CI、后备不能与主用相同等，配置拒绝的这里也拒绝。requiredChecks 与环节无关，给占位。
 */
function normalizeEnv(env) {
  const e = { ...DEFAULTS };
  for (const [k, v] of Object.entries(env)) if (v !== undefined && k !== 'userChoices') e[k] = v;
  for (const k of ['fullTests', 'reviewFlow']) if (e[k] === null) throw new Error(`${k} 不能是 null（不写才用默认值 ${JSON.stringify(DEFAULTS[k])}）`);
  for (const k of ['tight', 'externalExecutor']) if (typeof e[k] !== 'boolean') throw new Error(`${k} 必须是 true 或 false（当前 ${JSON.stringify(e[k])}）`);
  if (e.hasServer !== undefined && typeof e.hasServer !== 'boolean') throw new Error(`hasServer 必须是 true 或 false（当前 ${JSON.stringify(e.hasServer)}）`);
  try {
    const { fullTests, reviewFlow, ciRunner, ciFallback, session } = e;
    normalizeConfig(applyEnvironment({ profile: 2 }, { fullTests, reviewFlow, ciRunner, ciFallback, session }, { requiredChecks: fullTests === 'ci' ? ['占位'] : undefined }));
  } catch (err) {
    throw new Error(`环境取值不成立（与项目配置同一口径）：${err.message}`);
  }
  e.userChoices = { ...(env.userChoices || {}) };
  return e;
}

/** 决定一项“可选”的工作：用户的指定 > 项目选项里的会话偏好 > 两条原则 > 问用户。 */
function decideChoice(spec, env) {
  const base = { id: spec.id, label: spec.label };
  const asked = env.userChoices[spec.id];
  if (asked !== undefined && !spec.feasible.includes(asked)) {
    const why = asked === SERVER && spec.serverCapable && env.hasServer !== true ? '没有确认有可用的服务器（hasServer=true 才算）' : '这项工作不能放在那里';
    return { ...base, where: null, source: 'ask', options: spec.feasible, reason: `你指定的 ${asked} 现在做不到：${why}。请在这些里选：${spec.feasible.map((p) => COST[p]).join('；')}` };
  }
  if (asked !== undefined) return { ...base, where: asked, source: 'user', reason: `用户指定：${COST[asked]}` };
  const preferred = { local: LOCAL, cloud: CLOUD }[env.session];
  if (preferred && spec.feasible.includes(preferred)) return { ...base, where: preferred, source: 'config', reason: `项目选项 session=${env.session}（装套件时用户选的，或按推荐写入并告知过用户；可随时改）：${COST[preferred]}` };
  const winner = byPrinciples(spec.feasible, env.tight);
  if (winner) return { ...base, where: winner, source: 'principle', reason: `${spec.reason}。按“更快、更便宜、更高效”：${COST[winner]}${env.tight ? '（本机资源紧张）' : ''}` };
  return { ...base, where: null, source: 'ask', options: spec.feasible, reason: `${spec.reason}。多种做法都可行但原则指向不同，请你选：${spec.feasible.map((p) => COST[p]).join('；')}` };
}

/**
 * 决定一个环节里每项工作在哪做。env：fullTests、ciRunner、ciFallback、reviewFlow、session（项目配置）；
 * hasServer（true：有自己的服务器且 runner 在线；false：没有；不给：不知道）、tight（本机资源紧张）、externalExecutor（配了外部执行器）；
 * userChoices（工作编号 → 去处，工作编号必须是该环节里“可选”的工作）。取值不对就报错。
 * 返回 { stage, name, items: [{ id, label, where, source, reason, options? }] }；source 为 user、config、fixed、principle、ask（问用户时 where 为 null）。
 */
export function decideStage(stage, env = {}) {
  if (!STAGE_IDS.includes(stage)) throw new Error(`没有这个环节：${JSON.stringify(stage)}（通用环节只有 ${STAGE_IDS.join('、')}；发布和发布后验收见各项目自己的流程）`);
  const e = normalizeEnv(env);
  const specs = STAGES[stage].items(e);
  const choiceIds = specs.filter((s) => s.kind === 'choice').map((s) => s.id);
  for (const [id, where] of Object.entries(e.userChoices)) {
    if (!choiceIds.includes(id)) throw new Error(`环节 ${stage} 里没有可选去处的工作 ${JSON.stringify(id)}（可选的有：${choiceIds.join('、') || '无'}；其余工作的去处是固定的）`);
    if (!PLACES.includes(where)) throw new Error(`对 ${id} 的指定取值不对：${JSON.stringify(where)}（只能是 ${PLACES.join('、')}）`);
  }
  const items = specs.map((spec) => {
    if (spec.kind === 'choice') return decideChoice(spec, e);
    if (spec.kind === 'ask') return { id: spec.id, label: spec.label, where: null, source: 'ask', options: spec.options, reason: spec.reason };
    return { id: spec.id, label: spec.label, where: spec.where, source: spec.kind === 'config' ? 'config' : 'fixed', reason: spec.reason };
  });
  return { stage, name: STAGES[stage].name, items };
}

/** 命令行参数严格解析：未知参数、缺值、重复、写法不对都报错，不静默丢弃或覆盖。 */
export function parseStageArgs(argv) {
  const out = { stage: undefined, target: undefined, env: {}, userChoices: {} };
  const take = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v === '' || v.startsWith('--')) throw new Error(`${flag} 缺少值（不能是空字符串）`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!['--stage', '--target', '--choice'].includes(flag)) throw new Error(`不认识的参数 ${JSON.stringify(flag)}（只有 --stage、--target、--choice）`);
    const v = take(i, flag);
    if (flag === '--stage' || flag === '--target') {
      const key = flag.slice(2);
      if (out[key] !== undefined) throw new Error(`${flag} 只能写一次`);
      out[key] = v;
    } else if (flag === '--choice') {
      const m = v.match(/^([^=]+)=(.+)$/s);
      if (!m) throw new Error(`--choice 要写成 键=值（当前 ${JSON.stringify(v)}）`);
      const [, k, val] = m;
      const dup = k in out.env || k in out.userChoices;
      if (dup) throw new Error(`--choice ${k} 重复了`);
      if (['hasServer', 'externalExecutor', 'tight'].includes(k)) {
        if (val !== 'true' && val !== 'false') throw new Error(`--choice ${k} 只能是 true 或 false（当前 ${JSON.stringify(val)}）`);
        out.env[k] = val === 'true';
      } else out.userChoices[k] = val;
    } else throw new Error(`不认识的参数 ${JSON.stringify(flag)}（只有 --stage、--target、--choice）`);
  }
  if (!out.stage) throw new Error('缺少 --stage');
  return out;
}

/**
 * 读项目配置：优先 loadConfig（策略字段取基准提交上的，与闸门一致）；
 * 基准提交解析不了（loadConfig 带回 policyError）或读不到时，取工作区文件并如实标注来源，不假称是生效的策略。
 */
export function readProjectConfig(target) {
  const file = path.join(target, 'engineering.config.json');
  if (!fs.existsSync(file)) return { config: {}, configSource: 'none（没有 engineering.config.json，按默认值）' };
  // 不是 git 仓库的目录没有基准可言：直接用工作区文件并标注；Git 自己出错（不是“不是仓库”）要保留诊断，不能当普通目录
  const probe = git(target, ['rev-parse', '--git-dir']);
  if (!probe.ok) {
    if (!/not a git repository/i.test(probe.err)) throw new Error(`git 出错，无法判断 ${target} 是不是仓库：${probe.err.trim() || '没有诊断输出'}`);
    return { config: normalizeConfig(JSON.parse(fs.readFileSync(file, 'utf8'))), configSource: 'working-tree（不是 git 仓库，没有基准提交，用工作区文件）' };
  }
  // 是 git 仓库：读不出就报真实错误（例如基准提交上的配置是坏 JSON），不压成“读不到基准”
  const loaded = loadConfig(target);
  if (loaded.policyError) {
    return { config: loaded, configSource: `working-tree（无法取得基准提交上的判定策略：${loaded.policyError}；用工作区值，改配置的 PR 里可能比实际生效的更新）` };
  }
  // 策略字段取自哪里：基准提交上有配置就取它（标明提交号），没有（首次安装）就是工作区值，两种要分得清
  const rev = baseRevision(target, loaded.base).rev;
  const baseHasConfig = rev !== EMPTY_TREE && git(target, ['cat-file', '-e', `${rev}:engineering.config.json`]).ok;
  return baseHasConfig
    ? { config: loaded, configSource: `effective（策略字段取基准提交 ${rev.slice(0, 12)} 上的，与闸门一致）` }
    : { config: loaded, configSource: 'working-tree（基准提交上还没有配置（首次安装），策略字段取工作区值，与闸门此时的判定一致）' };
}

/** 把项目配置、命令行参数和本机事实合成 decideStage 的 env：命令行给的 tight 盖过本机探测，给的 hasServer、externalExecutor 原样带上。 */
export function buildEnv(config, args, facts) {
  return {
    fullTests: config.fullTests, ciRunner: config.ciRunner, ciFallback: config.ciFallback, reviewFlow: config.reviewFlow, session: config.session,
    ...args.env, tight: args.env.tight ?? isConstrained(facts), userChoices: args.userChoices,
  };
}

/** 命令行的全部流程：解析参数、读配置、（没给 tight 时）探测本机、决定。detect 可注入，测试用。返回要输出的对象。 */
export function planFromArgs(argv, { detect = detectFacts, cwd = process.cwd() } = {}) {
  const args = parseStageArgs(argv);
  const target = path.resolve(cwd, args.target ?? '.');
  const { config, configSource } = readProjectConfig(target);
  const facts = args.env.tight === undefined ? detect(target) : {};
  return { ...decideStage(args.stage, buildEnv(config, args, facts)), configSource };
}

if (isMain(import.meta.url)) {
  try {
    console.log(JSON.stringify(planFromArgs(process.argv.slice(2)), null, 2));
  } catch (e) {
    console.error(`环节决定失败：${e.message}`);
    process.exit(1);
  }
}
