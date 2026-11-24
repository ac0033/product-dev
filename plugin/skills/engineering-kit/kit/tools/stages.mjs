// 环节表：每个环节里的每项工作在哪做、为什么、谁定的。业务含义：
//   同一个任务要经过推送前（A）、PR 阶段（B）、合并与收尾（C）、每周巡检（W）几个环节，每个环节里有些工作只能在某处做，
//   有些在本机、云端会话、自己的服务器都行。决定顺序固定为：
//     1. 用户的选择（对具体工作的指定，或项目选项 modules.environment.session）；
//     2. 用户没选时按两条原则自动判断：本机的实际情况（资源紧不紧、有没有服务器），以及更快、更便宜、更高效、更准确；
//     3. 多种做法都可行、两条原则指向不同（例如云端更快但要花钱、本机更省但慢）时，问用户，列出可选项和各自代价。
//   发布与发布后验收（D、E）不在这里：它们是各项目自己的流程，本仓库的见 docs/release/README.md。
// 用法：node tools/stages.mjs --stage A|B|C|W [--target <项目>] [--choice <键=值>]…   输出该环节的决定（JSON）
//   --choice 的键：hasServer、externalExecutor（true/false），以及对具体工作的指定“工作编号=local-session|cloud-session|server”。
import fs from 'node:fs';
import path from 'node:path';
import { normalizeConfig } from '../gate/config.mjs';
import { isMain } from '../gate/lib.mjs';
import { detectFacts, isConstrained } from './environment.mjs';

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

/** 按两条原则从可行的去处里选：有一个在“便宜、快”上不输给其他、且至少一项更好的就选它；并列时取省事的；否则返回 null（要问用户）。 */
function byPrinciples(feasible, tight) {
  const t = traits(tight);
  const better = (a, b) => t[a].cheap >= t[b].cheap && t[a].fast >= t[b].fast && (t[a].cheap > t[b].cheap || t[a].fast > t[b].fast);
  const front = feasible.filter((a) => !feasible.some((b) => b !== a && better(b, a)));
  if (front.length === 1) return front[0];
  const same = front.every((a) => t[a].cheap === t[front[0]].cheap && t[a].fast === t[front[0]].fast);
  if (!same) return null;
  return [...front].sort((a, b) => t[b].easy - t[a].easy)[0];
}

const fixed = (id, label, where, reason) => ({ id, label, kind: 'fixed', where, reason });
const choice = (id, label, feasible, reason) => ({ id, label, kind: 'choice', feasible, reason });

/** 每个环节有哪些工作（随项目配置增减）。 */
const STAGES = {
  A: {
    name: '推送前',
    items: (env) => [
      fixed('static', '静态检查（闸门）', 'current-session', '快、不占额外资源，推送前必须过（R4）'),
      fixed('affected', '受影响测试', 'current-session', '只跑受影响的分组，本机或云端会话都很快，推送前必须过'),
      ...(env.fullTests === 'local' ? [choice('full-tests-local', '全量测试（fullTests=local）', [LOCAL, CLOUD], '全量测试耗时长、占资源，在会话所在环境由闸门跑并写测试记录')] : []),
      ...(env.reviewFlow === 'pre-push' ? [fixed('review-record', '复审登记（pre-push 流程）', 'same-copy', '复审记录写在做推送的那个仓库副本里，不跨副本共享，所以复审、登记、推送要在同一个副本里做完')] : []),
    ],
  },
  B: {
    name: 'PR 阶段',
    items: (env) => [
      ...(env.fullTests === 'ci'
        ? [{ id: 'ci-full-tests', label: '全量测试（CI）', kind: 'config', where: env.ciRunner === 'self-hosted' ? SERVER : 'github-hosted', reason: `按项目选项 fullTests=ci、ciRunner=${env.ciRunner}${env.ciFallback ? `，后备 ${env.ciFallback}（切换用仓库变量 CI_RUNNER）` : ''}；CI 在最终提交上跑，合并入口核对` }]
        : []),
      fixed('independent-reviews', '独立代码复审与一致性审', env.externalExecutor ? 'executor-machine' : 'current-session',
        env.externalExecutor
          ? '外部执行器（如 Codex）的命令和模型写在仓库之外的本机配置，只能在配了它的机器上跑；理论上可以迁到服务器，但 Linux 上只读沙箱等行为未验证，须先测试再迁，目前不实现'
          : '由宿主子代理或用户另开的全新会话做，不共享作者上下文；复审可以与 CI 并行开始'),
      fixed('fix-findings', '处理复审意见、修复失败', 'current-session', '创造性工作，需要判断，排在用户在场的时段'),
    ],
  },
  C: {
    name: '合并与收尾',
    items: () => [
      fixed('merge-entry', '合并入口（核对 CI 与审查记录）', 'same-copy', '审查记录不跨副本共享，要在登记它的同一个仓库副本里合并；合并要用户授权（R2）'),
      fixed('cleanup', '删除分支、清理工作树', 'current-session', '合并后立即做，汇报“完成”前确认已清理'),
      fixed('wrap-up', '汇报与经验提炼', 'current-session', '需要判断和用户沟通，不外包'),
    ],
  },
  W: {
    name: '每周巡检',
    items: (env) => [choice('weekly-inspection', '每周巡检（重复性工作）', env.hasServer ? [LOCAL, CLOUD, SERVER] : [LOCAL, CLOUD], '不需要人参与的重复性工作，攒成整块在用户离开后跑，尽量不占本机')],
  },
};

const DEFAULT_ENV = { fullTests: 'local', ciRunner: null, ciFallback: null, reviewFlow: 'pre-push', session: null, hasServer: false, tight: false, externalExecutor: false, userChoices: {} };

/** 决定一项“可选”的工作：用户的指定 > 项目选项里的会话偏好 > 两条原则 > 问用户。 */
function decideChoice(spec, env) {
  const base = { id: spec.id, label: spec.label };
  const asked = env.userChoices[spec.id];
  if (asked !== undefined && !spec.feasible.includes(asked)) {
    return { ...base, where: null, source: 'ask', options: spec.feasible, reason: `你指定的 ${asked} 现在做不到（${asked === SERVER ? '没有确认有自己的服务器' : '不在可选范围内'}），请在这些里选：${spec.feasible.map((p) => COST[p]).join('；')}` };
  }
  if (asked !== undefined) return { ...base, where: asked, source: 'user', reason: `用户指定：${COST[asked]}` };
  const preferred = { local: LOCAL, cloud: CLOUD }[env.session];
  if (preferred && spec.feasible.includes(preferred)) return { ...base, where: preferred, source: 'user', reason: `项目选项 session=${env.session}（用户的选择）：${COST[preferred]}` };
  if (spec.feasible.length === 1) return { ...base, where: spec.feasible[0], source: 'fixed', reason: `${spec.reason}；只有这一处可行` };
  const winner = byPrinciples(spec.feasible, env.tight);
  if (winner) return { ...base, where: winner, source: 'principle', reason: `${spec.reason}。按“更快、更便宜、更高效”：${COST[winner]}${env.tight ? '（本机资源紧张）' : ''}` };
  return { ...base, where: null, source: 'ask', options: spec.feasible, reason: `${spec.reason}。多种做法都可行但原则指向不同，请你选：${spec.feasible.map((p) => COST[p]).join('；')}` };
}

/**
 * 决定一个环节里每项工作在哪做。env：fullTests、ciRunner、ciFallback、reviewFlow、session（项目配置）；
 * hasServer、tight（本机资源紧张）、externalExecutor（配了外部执行器）；userChoices（工作编号 → 去处）。
 * 返回 { stage, name, items: [{ id, label, where, source, reason, options? }] }；source 为 user、config、fixed、principle、ask（问用户时 where 为 null）。
 */
export function decideStage(stage, env = {}) {
  if (!STAGE_IDS.includes(stage)) throw new Error(`没有这个环节：${JSON.stringify(stage)}（通用环节只有 ${STAGE_IDS.join('、')}；发布和发布后验收见各项目自己的流程）`);
  const e = { ...DEFAULT_ENV, ...env, userChoices: { ...(env.userChoices || {}) } };
  for (const [id, where] of Object.entries(e.userChoices)) {
    if (!PLACES.includes(where)) throw new Error(`对 ${id} 的指定取值不对：${JSON.stringify(where)}（只能是 ${PLACES.join('、')}）`);
  }
  const items = STAGES[stage].items(e).map((spec) => {
    if (spec.kind === 'choice') return decideChoice(spec, e);
    return { id: spec.id, label: spec.label, where: spec.where, source: spec.kind === 'config' ? 'config' : 'fixed', reason: spec.reason };
  });
  return { stage, name: STAGES[stage].name, items };
}

if (isMain(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    let stage;
    let target = process.cwd();
    const env = { userChoices: {} };
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === '--stage') stage = argv[++i];
      else if (argv[i] === '--target') target = path.resolve(argv[++i]);
      else if (argv[i] === '--choice') {
        const [k, v = ''] = String(argv[++i]).split(/=(.*)/s);
        if (k === 'hasServer' || k === 'externalExecutor') env[k] = v === 'true';
        else env.userChoices[k] = v;
      }
    }
    if (!STAGE_IDS.includes(stage)) throw new Error(`没有这个环节：${JSON.stringify(stage)}（通用环节只有 ${STAGE_IDS.join('、')}）`);
    const file = path.join(target, 'engineering.config.json');
    const config = fs.existsSync(file) ? normalizeConfig(JSON.parse(fs.readFileSync(file, 'utf8'))) : {};
    const facts = detectFacts(target);
    const decision = decideStage(stage, {
      fullTests: config.fullTests, ciRunner: config.ciRunner, ciFallback: config.ciFallback, reviewFlow: config.reviewFlow, session: config.session,
      tight: isConstrained(facts), ...env,
    });
    console.log(JSON.stringify(decision, null, 2));
  } catch (e) {
    console.error(`环节决定失败：${e.message}`);
    process.exit(1);
  }
}
