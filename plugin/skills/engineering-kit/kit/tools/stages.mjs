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
import { isMain, loadConfig } from '../gate/lib.mjs';
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

const fixed = (id, label, where, reason) => ({ id, label, kind: 'fixed', where, reason });
/** serverCapable：这项工作原则上能放在自己的服务器上（还要 hasServer 确认才算可行）；全量测试、本机的工作不能。 */
const choice = (id, label, feasible, reason, serverCapable = false) => ({ id, label, kind: 'choice', feasible, reason, serverCapable });
const reviewWhere = (env) => (env.externalExecutor ? 'executor-machine' : 'current-session');
const REVIEW_REASON = (env) => (env.externalExecutor
  ? '外部执行器（如 Codex）的命令和模型写在仓库之外的本机配置，只能在配了它的机器上跑；理论上可以迁到服务器，但 Linux 上只读沙箱、无工具等行为未验证，须先测试再迁，目前不实现'
  : '由宿主子代理或用户另开的全新会话做，不共享作者上下文');

/** 每个环节有哪些工作（随项目配置增减；env 已经过校验和补全）。 */
const STAGES = {
  A: {
    name: '推送前',
    items: (env) => [
      fixed('static', '静态检查（闸门）', 'current-session', '快、不占额外资源，推送前必须过（R4）'),
      fixed('affected', '受影响测试', 'current-session', '只跑受影响的分组，本机或云端会话都很快，推送前必须过'),
      ...(env.fullTests === 'local' ? [choice('full-tests-local', '全量测试（fullTests=local）', [LOCAL, CLOUD], '全量测试耗时长、占资源，在会话所在环境由闸门跑并写测试记录')] : []),
      ...(env.reviewFlow === 'pre-push'
        ? [
          fixed('independent-reviews', '独立代码复审与一致性审（pre-push 流程，推送前做）', reviewWhere(env), REVIEW_REASON(env)),
          fixed('review-record', '复审登记（pre-push 流程）', 'same-worktree', '复审记录写在该工作树自己的 git 目录里，同一仓库的不同工作树、不同副本都不共享，所以复审、登记、推送要在同一个工作树里做完'),
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
          fixed('independent-reviews', '独立代码复审与一致性审（pr 流程，可与 CI 并行开始）', reviewWhere(env), REVIEW_REASON(env)),
          fixed('review-register', '登记审查记录（CI 全部通过后）', 'same-copy', 'PR 审查记录放在 git 公共目录，同一仓库副本的各工作树共享，不跨副本，所以要在合并入口所在的那个副本里登记'),
        ]
        : []),
      fixed('fix-findings', '处理复审意见、修复失败', 'current-session', '创造性工作，需要判断，排在用户在场的时段'),
    ],
  },
  C: {
    name: '合并与收尾',
    items: (env) => [
      env.reviewFlow === 'pr'
        ? fixed('merge-entry', '合并入口（核对 CI 与审查记录）', 'same-copy', '审查记录不跨副本共享，要在登记它的同一个仓库副本里合并；合并要用户授权（R2）')
        : fixed('merge', '合并（pre-push 流程没有合并入口脚本）', 'current-session', '按项目约定合并，合并要用户授权（R2）；等 PR 的必需检查全部通过，不绕过失败的检查；复审与测试记录只证明推送前的状态，不能证明对 PR 最终提交的双审'),
      fixed('cleanup', '删除分支、清理工作树', 'current-session', '合并后立即做，汇报“完成”前确认已清理'),
      fixed('wrap-up', '汇报与经验提炼', 'current-session', '需要判断和用户沟通，不外包'),
    ],
  },
  W: {
    name: '每周巡检',
    items: (env) => [choice('weekly-inspection', '每周巡检（重复性工作）', env.hasServer === true ? [LOCAL, CLOUD, SERVER] : [LOCAL, CLOUD], '不需要人参与的重复性工作，攒成整块在用户离开后跑，尽量不占本机', true)],
  },
};

/** B 环节的 CI 全量测试：按项目选项落到托管或服务器；配了自托管却明确没有服务器时转问用户。 */
function ciItem(env) {
  const label = '全量测试（CI）';
  const note = '本命令读不到仓库变量 CI_RUNNER：若已用它切换了 Linux 的 runner，以实际为准；Windows、macOS 矩阵项始终在 GitHub 托管 runner 上跑';
  if (env.ciRunner === 'self-hosted' && env.hasServer === false) {
    return { id: 'ci-full-tests', label, kind: 'ask', options: ['server', 'github-hosted'], reason: `项目选项 ciRunner=self-hosted，但你说没有可用的服务器：请选改用 github-hosted，或先准备好服务器和 runner。${note}` };
  }
  return {
    id: 'ci-full-tests', label, kind: 'config', where: env.ciRunner === 'self-hosted' ? SERVER : 'github-hosted',
    reason: `按项目选项 fullTests=ci、ciRunner=${env.ciRunner}${env.ciFallback ? `，后备 ${env.ciFallback}（切换用仓库变量 CI_RUNNER）` : ''}；CI 在最终提交上跑，合并入口核对。${note}`,
  };
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
  if (preferred && spec.feasible.includes(preferred)) return { ...base, where: preferred, source: 'user', reason: `项目选项 session=${env.session}（装套件时用户选的，或用户接受了推荐的）：${COST[preferred]}` };
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
  let loaded = null;
  try {
    loaded = loadConfig(target);
  } catch {
    loaded = null;
  }
  if (loaded && !loaded.policyError) return { config: loaded, configSource: 'effective（基准提交上生效的策略字段，与闸门一致）' };
  const file = path.join(target, 'engineering.config.json');
  if (!fs.existsSync(file)) return { config: {}, configSource: 'none（没有 engineering.config.json，按默认值）' };
  const why = loaded?.policyError ? `无法取得基准提交上的判定策略（${loaded.policyError}）` : '读不到基准提交';
  return { config: normalizeConfig(JSON.parse(fs.readFileSync(file, 'utf8'))), configSource: `working-tree（${why}，用工作区文件；改配置的 PR 里可能比实际生效的更新）` };
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
