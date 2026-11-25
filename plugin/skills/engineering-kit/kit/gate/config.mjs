// 项目配置（engineering.config.json）的 profile 结构与展开。业务含义：
//   项目配置是唯一由项目自己维护的文件，结构分四段，便于升级时只改动套件认可的字段：
//     modules  —— 模块参数：gate（基准分支、测试命令、环境变量、测试分组 testGroups、锁时长、复审流程 reviewFlow、必需检查 requiredChecks、执行位置 fullTests 与 ciRunner）、
//                 review（复审者名单、报告必需的节 reviewSections、可选的最少字数 reviewMinChars、结论关键词、复审轮次上限 maxReviewRounds、允许的外部复审执行器 externalExecutors、外发前追加排除 externalExclude）
//     layout   —— 目录布局：源文件与测试的 glob、阶段目录、允许的顶层目录
//     hygiene  —— 巡检参数：禁用文件名片段、草稿超期天数、记录类目录、合法状态值
//     rules    —— 规则：不计入闸门的文档（reviewIgnore；项目配置、豁免表、套件脚本除外，永远计入）、注释检查模式（commentMode）
//   这里只做结构展开与取值校验。闸门运行时 base 与判定策略字段（reviewIgnore、reviewFlow、requiredChecks、reviewers、reviewMinChars、reviewSections、reviewKeyword、maxReviewRounds、externalExecutors、externalExclude、fullTests、ciRunner）
//   的生效值不取工作区，而取主干或基准提交上的配置，见 lib.mjs 的 loadConfig。
//   闸门内部只使用“扁平”字段（FLAT_KEYS），由 normalizeConfig 展开；旧版扁平配置仍可读取，便于回滚。
// 同步器通过 toProfile / toFlat 在两种结构之间转换，保证回滚到旧版本时配置格式也随之回退。

/** 闸门使用的扁平字段名（与旧版 engineering.config.json 相同）。 */
export const FLAT_KEYS = [
  'base', 'sourceGlobs', 'testGlobs', 'reviewIgnore', 'commentMode', 'testCommand', 'testEnv',
  'reviewers', 'reviewMinChars', 'reviewSections', 'reviewKeyword', 'lockMaxAgeMinutes', 'reviewFlow', 'testGroups', 'maxReviewRounds', 'requiredChecks',
  'externalExecutors', 'externalExclude', 'fullTests', 'ciRunner', 'ciFallback', 'ciOs', 'session', 'parallel',
];

/**
 * 扁平字段的缺省值。reviewIgnore 只放真正的纯说明文件（docs 下的 Markdown、根目录的 README 与 CHANGELOG）：
 * 规则（AGENTS.md、CLAUDE.md）、技能正文、提示词、可执行原型都会改变行为，不默认免审（0.7.0 起；之前是全部 Markdown 加整个 docs 目录）。
 * reviewSections 是复审报告必需的节（结论一节另按 reviewKeyword 判定）；reviewMinChars 0.7.0 起默认 0，不再按字数判定，只有项目显式写了正数才继续检查（旧配置里写的 200 照常生效）。
 * requiredChecks 为空表示 PR 上报告的每一项 CI 检查都是必需检查。externalExecutors 为空表示不允许外部复审（external-review.mjs）。
 */
export const DEFAULTS = {
  base: 'auto',
  sourceGlobs: [],
  testGlobs: [],
  reviewIgnore: ['docs/**/*.md', 'README.md', 'CHANGELOG.md'],
  commentMode: 'header+exports',
  testCommand: 'npm test',
  testEnv: {},
  reviewers: ['product-dev:code-reviewer', 'feature-dev:code-reviewer', '/code-review', 'general-purpose'],
  reviewMinChars: 0,
  reviewSections: ['范围', '发现', '作者的验证'],
  reviewKeyword: '结论',
  lockMaxAgeMinutes: 90,
  reviewFlow: 'pre-push',
  testGroups: [],
  maxReviewRounds: 3,
  requiredChecks: [],
  externalExecutors: [],
  externalExclude: [],
  fullTests: 'local',
  ciRunner: null,
  ciFallback: null,
  ciOs: ['linux'],
  session: null,
  parallel: null,
};

/** 复审流程的合法取值：pre-push（推送前复审，推送核对只要求代码复审）或 pr（对 PR 最终提交做代码复审与一致性审：复审可以与 CI 并行开始；CI 全部通过后才登记、合并，经 merge.mjs 合并）。 */
export const REVIEW_FLOWS = ['pre-push', 'pr'];

/**
 * 执行位置（modules.gate.fullTests、ciRunner）的合法取值。fullTests：全量测试由谁跑——local（闸门在当前会话所在环境跑，默认）或 ci（交给 CI，闸门只做静态检查）；
 * ciRunner：CI 放哪——github-hosted（GitHub 托管 runner）、self-hosted（用户服务器上的自托管 runner，同样是 GitHub Actions）、none（没有 CI）；不写表示未声明。
 */
export const FULL_TESTS = ['local', 'ci'];
export const CI_RUNNERS = ['github-hosted', 'self-hosted', 'none'];

/**
 * 环境选项（modules.environment，装套件时按用户的实际情况选，用户不选时由 agent 按 tools/environment.mjs 的推荐原则给出）：
 * ciOs 是 CI 跑在哪些系统上（默认只 linux：最快最便宜，Windows 按 2 倍、macOS 按 10 倍计费）；session 是开发和重复性工作更适合在本地会话（local）还是云端会话（cloud）做，
 * 不写表示未声明，agent 按推荐原则选；parallel 是能并行的工作并行（parallel）还是串行（serial），不写同上。ciFallback 是主 CI 额度用完或不可用时改用的另一处（只能与 ciRunner 不同）。
 */
export const OS_NAMES = ['linux', 'windows', 'macos'];
export const SESSIONS = ['local', 'cloud'];
export const PARALLEL_MODES = ['parallel', 'serial'];

/** 目录布局与巡检的缺省值（profile 的 layout、hygiene 段）。 */
export const LAYOUT_DEFAULTS = {
  stages: ['00-总览', '01-需求', '02-原型', '03-架构', '04-开发', '05-测试', '06-发布'],
  topLevelAllowed: ['docs', 'src', 'tests', 'scripts', 'config', 'templates', '.github', '.claude', '.impeccable'],
};
export const HYGIENE_DEFAULTS = {
  bannedNameTokens: ['copy', 'final', 'bak', 'old', 'tmp'],
  staleDraftDays: 30,
  recordDirs: ['docs/acceptance', 'docs/adr', 'docs/release'],
  statusValues: ['draft', 'review', 'active', 'accepted', 'superseded', 'done', 'archived'],
};

/** 是否为普通对象（不是数组、不是 null）。 */
function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 把任意一段配置校验为对象；缺失视为空对象，类型错误直接报错。 */
function section(raw, name) {
  if (raw[name] === undefined) return {};
  if (!isObject(raw[name])) throw new Error(`engineering.config.json 的 ${name} 必须是对象`);
  return raw[name];
}

/**
 * 把原始配置（profile 结构或旧版扁平结构）展开为闸门使用的有效配置。
 * 返回对象包含全部扁平字段，以及 layout、hygiene 两个子对象。
 */
export function normalizeConfig(raw) {
  const eff = expand(raw);
  if (!REVIEW_FLOWS.includes(eff.reviewFlow)) {
    throw new Error(`engineering.config.json 的 modules.gate.reviewFlow 只能是 ${REVIEW_FLOWS.join(' 或 ')}（当前 ${JSON.stringify(eff.reviewFlow)}）`);
  }
  if (!Number.isInteger(eff.maxReviewRounds) || eff.maxReviewRounds < 1) {
    throw new Error(`engineering.config.json 的 modules.review.maxReviewRounds 必须是正整数（当前 ${JSON.stringify(eff.maxReviewRounds)}）`);
  }
  checkTypes(eff);
  checkExecution(eff);
  checkTestGroups(eff.testGroups);
  checkRequiredChecks(eff.requiredChecks);
  if (!Array.isArray(eff.reviewSections) || !eff.reviewSections.every((x) => typeof x === 'string' && x.trim() && x === x.trim() && !x.includes(String.fromCharCode(10))) || new Set(eff.reviewSections).size !== eff.reviewSections.length) {
    throw new Error('engineering.config.json 的 modules.review.reviewSections 必须是不重复的字符串数组，节名不能为空、不能有首尾空白和换行（写成空数组表示不要求任何节）');
  }
  for (const k of ['externalExecutors', 'externalExclude']) {
    const v = eff[k];
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x.trim())) throw new Error(`engineering.config.json 的 modules.review.${k} 必须是非空字符串数组`);
  }
  return eff;
}

/** 注释检查模式的合法取值。 */
export const COMMENT_MODES = ['header', 'header+exports'];

/**
 * 校验其余字段的类型（新旧两种结构展开后共用）：写错的类型会让某项检查静默失效（如 reviewMinChars 写成字符串，最少字数检查就不执行），
 * 所以一律报错，不回退默认值。允许 null 的只有 ciRunner、ciFallback、session、parallel（表示未声明，见 checkExecution）。
 */
function checkTypes(eff) {
  const at = (k) => `engineering.config.json 的 ${k}`;
  const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
  if (!nonEmpty(eff.base)) throw new Error(`${at('modules.gate.base')} 必须是非空字符串（当前 ${JSON.stringify(eff.base)}）`);
  if (!nonEmpty(eff.testCommand)) throw new Error(`${at('modules.gate.testCommand')} 必须是非空字符串（当前 ${JSON.stringify(eff.testCommand)}）`);
  if (!isObject(eff.testEnv) || !Object.values(eff.testEnv).every((v) => typeof v === 'string')) throw new Error(`${at('modules.gate.testEnv')} 必须是值为字符串的对象（当前 ${JSON.stringify(eff.testEnv)}）`);
  if (typeof eff.lockMaxAgeMinutes !== 'number' || !Number.isFinite(eff.lockMaxAgeMinutes) || eff.lockMaxAgeMinutes <= 0) throw new Error(`${at('modules.gate.lockMaxAgeMinutes')} 必须是正数（当前 ${JSON.stringify(eff.lockMaxAgeMinutes)}）`);
  if (!Number.isInteger(eff.reviewMinChars) || eff.reviewMinChars < 0) throw new Error(`${at('modules.review.reviewMinChars')} 必须是非负整数（当前 ${JSON.stringify(eff.reviewMinChars)}）`);
  if (!nonEmpty(eff.reviewKeyword)) throw new Error(`${at('modules.review.reviewKeyword')} 必须是非空字符串（当前 ${JSON.stringify(eff.reviewKeyword)}）`);
  if (!COMMENT_MODES.includes(eff.commentMode)) throw new Error(`${at('rules.commentMode')} 只能是 ${COMMENT_MODES.join(' 或 ')}（当前 ${JSON.stringify(eff.commentMode)}）`);
  for (const [k, where] of [['reviewers', 'modules.review.reviewers'], ['sourceGlobs', 'layout.sourceGlobs'], ['testGlobs', 'layout.testGlobs'], ['reviewIgnore', 'rules.reviewIgnore']]) {
    const v = eff[k];
    if (!Array.isArray(v) || !v.every(nonEmpty)) throw new Error(`${at(where)} 必须是非空字符串组成的数组（当前 ${JSON.stringify(v)}）`);
  }
}

/**
 * 校验执行位置：fullTests、ciRunner 的取值；fullTests 为 ci 时须是 pr 流程（只有 pr 流程的合并入口核对 CI 在最终提交上全部通过，
 * pre-push 流程不核对 CI，配成 ci 等于全量测试没有强制执行点），且 ciRunner 已声明为 github-hosted 或 self-hosted。不满足时报错，不静默降级。
 */
function checkExecution(eff) {
  const where = 'engineering.config.json 的 modules.gate';
  if (!FULL_TESTS.includes(eff.fullTests)) throw new Error(`${where}.fullTests 只能是 ${FULL_TESTS.join(' 或 ')}（当前 ${JSON.stringify(eff.fullTests)}）`);
  if (eff.ciRunner !== null && !CI_RUNNERS.includes(eff.ciRunner)) {
    throw new Error(`${where}.ciRunner 只能是 ${CI_RUNNERS.join('、')}，或不写表示未声明（当前 ${JSON.stringify(eff.ciRunner)}）`);
  }
  if (eff.ciFallback !== null) {
    if (!CI_RUNNERS.includes(eff.ciFallback) || eff.ciFallback === 'none') throw new Error(`${where}.ciFallback 只能是 github-hosted、self-hosted，或不写（当前 ${JSON.stringify(eff.ciFallback)}）`);
    if (eff.ciRunner === null || eff.ciRunner === 'none' || eff.ciRunner === eff.ciFallback) {
      throw new Error(`${where}.ciFallback 须在 ciRunner 已声明（不是 none）时才能写，且不能与 ciRunner 相同（ciRunner ${JSON.stringify(eff.ciRunner)}，ciFallback ${JSON.stringify(eff.ciFallback)}）`);
    }
  }
  const env = 'engineering.config.json 的 modules.environment';
  if (!Array.isArray(eff.ciOs) || eff.ciOs.length === 0 || !eff.ciOs.every((o) => OS_NAMES.includes(o)) || new Set(eff.ciOs).size !== eff.ciOs.length) {
    throw new Error(`${env}.ciOs 必须是不重复的非空数组，取值只能是 ${OS_NAMES.join('、')}（当前 ${JSON.stringify(eff.ciOs)}）`);
  }
  if (eff.session !== null && !SESSIONS.includes(eff.session)) throw new Error(`${env}.session 只能是 ${SESSIONS.join(' 或 ')}，或不写（当前 ${JSON.stringify(eff.session)}）`);
  if (eff.parallel !== null && !PARALLEL_MODES.includes(eff.parallel)) throw new Error(`${env}.parallel 只能是 ${PARALLEL_MODES.join(' 或 ')}，或不写（当前 ${JSON.stringify(eff.parallel)}）`);
  if (eff.fullTests === 'ci') {
    if (eff.reviewFlow !== 'pr') throw new Error(`${where}.fullTests 为 ci 须搭配 pr 流程（reviewFlow: "pr"）：只有 pr 流程的合并入口核对 CI 全部通过，pre-push 流程不核对 CI`);
    if (eff.ciRunner !== 'github-hosted' && eff.ciRunner !== 'self-hosted') {
      throw new Error(`${where}.fullTests 为 ci 须声明 ciRunner 为 github-hosted 或 self-hosted（当前 ${JSON.stringify(eff.ciRunner)}）`);
    }
    // 必需检查为空表示“PR 上每一项检查都算必需”：一个只跑 lint 的 CI 成功也会放行合并，而本机又不要求测试记录——所以须写明哪些检查跑全量
    if (!Array.isArray(eff.requiredChecks) || eff.requiredChecks.length === 0) {
      throw new Error(`${where}.fullTests 为 ci 须在 requiredChecks 里写明跑全量测试的检查名（不写会让任何一项成功的检查放行合并）`);
    }
  }
}

/**
 * 校验测试分组（modules.gate.testGroups）：数组，每项 { name, paths, command }——name 是不重复的非空字符串，
 * paths 是非空的 glob 数组（相对仓库根，斜杠分隔），command 是非空的测试命令。格式不对时抛错，不静默忽略。
 */
function checkTestGroups(groups) {
  const where = 'engineering.config.json 的 modules.gate.testGroups';
  if (!Array.isArray(groups)) throw new Error(`${where} 必须是数组`);
  const names = new Set();
  groups.forEach((g, i) => {
    const at = `${where} 第 ${i + 1} 项`;
    if (!isObject(g)) throw new Error(`${at} 必须是对象 { name, paths, command }`);
    if (typeof g.name !== 'string' || !g.name.trim()) throw new Error(`${at} 缺少 name（非空字符串）`);
    if (names.has(g.name)) throw new Error(`${where} 的分组名 ${g.name} 重复`);
    names.add(g.name);
    if (!Array.isArray(g.paths) || g.paths.length === 0 || !g.paths.every((p) => typeof p === 'string' && p.trim())) {
      throw new Error(`${at}（${g.name}）的 paths 必须是非空的 glob 数组`);
    }
    if (typeof g.command !== 'string' || !g.command.trim()) throw new Error(`${at}（${g.name}）缺少 command（非空字符串）`);
  });
}

/**
 * 校验必需检查名（modules.gate.requiredChecks）：不重复的非空字符串数组，写检查运行的 name（job 名，含矩阵后缀，不含工作流名和事件）或提交状态的 context。
 * 格式不对时抛错：拼错的类型会让必需检查静默变少，不能忽略。
 */
function checkRequiredChecks(names) {
  const where = 'engineering.config.json 的 modules.gate.requiredChecks';
  if (!Array.isArray(names) || !names.every((n) => typeof n === 'string' && n.trim())) throw new Error(`${where} 必须是检查名（非空字符串）数组`);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup !== undefined) throw new Error(`${where} 的检查名 ${dup} 重复`);
}

/**
 * 取配置段里的一项：没写（键不存在或 undefined）用默认值；写了就原样交给 normalizeConfig 校验。
 * 显式写成 null 而默认值不是 null 的（如 fullTests、ciOs）报错，不静默回退默认值：null 不是“未写”，写错了要让人看见。
 * 默认值本身是 null 的键（ciRunner、ciFallback、session、parallel）写 null 等于不写。
 */
function pick(obj, key, where) {
  if (!Object.hasOwn(obj, key) || obj[key] === undefined) return DEFAULTS[key];
  if (obj[key] === null && DEFAULTS[key] !== null) throw new Error(`engineering.config.json 的 ${where ? `${where}.` : ''}${key} 不能是 null：不写表示用默认值 ${JSON.stringify(DEFAULTS[key])}，要改就写合法取值`);
  return obj[key];
}

/** 展开两种结构（取值校验由 normalizeConfig 统一做）。 */
function expand(raw) {
  if (!isObject(raw)) throw new Error('engineering.config.json 必须是 JSON 对象');
  if (raw.profile === undefined) {
    // 旧版扁平结构：原样使用，缺省值补齐；_profile 段（回滚时保存的 profile 专有设置）同样生效
    const prof = isObject(raw._profile) ? raw._profile : {};
    for (const k of FLAT_KEYS) pick(raw, k, '');
    return {
      ...DEFAULTS,
      ...raw,
      layout: { ...LAYOUT_DEFAULTS, ...(prof.layout || {}), sourceGlobs: pick(raw, 'sourceGlobs', ''), testGlobs: pick(raw, 'testGlobs', '') },
      hygiene: { ...HYGIENE_DEFAULTS, ...(prof.hygiene || {}) },
    };
  }
  if (raw.profile !== 2) throw new Error(`不支持的配置 profile 版本：${raw.profile}（当前只认 2）`);
  const modules = section(raw, 'modules');
  const gate = isObject(modules.gate) ? modules.gate : (modules.gate === undefined ? {} : (() => { throw new Error('engineering.config.json 的 modules.gate 必须是对象'); })());
  const review = isObject(modules.review) ? modules.review : (modules.review === undefined ? {} : (() => { throw new Error('engineering.config.json 的 modules.review 必须是对象'); })());
  const layout = section(raw, 'layout');
  const hygiene = section(raw, 'hygiene');
  const environment = isObject(modules.environment) ? modules.environment : (modules.environment === undefined ? {} : (() => { throw new Error('engineering.config.json 的 modules.environment 必须是对象'); })());
  const rules = section(raw, 'rules');
  const lay = { ...LAYOUT_DEFAULTS, ...layout };
  const hyg = { ...HYGIENE_DEFAULTS, ...hygiene };
  return {
    base: pick(gate, 'base', 'modules.gate'),
    testCommand: pick(gate, 'testCommand', 'modules.gate'),
    testEnv: pick(gate, 'testEnv', 'modules.gate'),
    lockMaxAgeMinutes: pick(gate, 'lockMaxAgeMinutes', 'modules.gate'),
    reviewFlow: pick(gate, 'reviewFlow', 'modules.gate'),
    testGroups: pick(gate, 'testGroups', 'modules.gate'),
    requiredChecks: pick(gate, 'requiredChecks', 'modules.gate'),
    fullTests: pick(gate, 'fullTests', 'modules.gate'),
    ciRunner: pick(gate, 'ciRunner', 'modules.gate'),
    ciFallback: pick(gate, 'ciFallback', 'modules.gate'),
    ciOs: pick(environment, 'ciOs', 'modules.environment'),
    session: pick(environment, 'session', 'modules.environment'),
    parallel: pick(environment, 'parallel', 'modules.environment'),
    reviewers: pick(review, 'reviewers', 'modules.review'),
    reviewMinChars: pick(review, 'reviewMinChars', 'modules.review'),
    reviewSections: pick(review, 'reviewSections', 'modules.review'),
    reviewKeyword: pick(review, 'reviewKeyword', 'modules.review'),
    maxReviewRounds: pick(review, 'maxReviewRounds', 'modules.review'),
    externalExecutors: pick(review, 'externalExecutors', 'modules.review'),
    externalExclude: pick(review, 'externalExclude', 'modules.review'),
    sourceGlobs: pick(layout, 'sourceGlobs', 'layout'),
    testGlobs: pick(layout, 'testGlobs', 'layout'),
    reviewIgnore: pick(rules, 'reviewIgnore', 'rules'),
    commentMode: pick(rules, 'commentMode', 'rules'),
    layout: lay,
    hygiene: hyg,
  };
}

/**
 * 扁平配置 → profile 结构（同步器写入新格式时使用）。扁平结构里 _profile 段保存的布局与巡检设置原样恢复。
 * 测试分组、必需检查名、最少字数和外部复审的两项是可选项：没有时不写，迁移旧配置不凭空多出一项。
 */
export function toProfile(flat, { keepZeroMinChars = false } = {}) {
  const f = normalizeConfig(flat);
  const { sourceGlobs, testGlobs, stages, topLevelAllowed } = { ...f.layout, sourceGlobs: f.sourceGlobs, testGlobs: f.testGlobs };
  const gate = { base: f.base, testCommand: f.testCommand, testEnv: f.testEnv, lockMaxAgeMinutes: f.lockMaxAgeMinutes, reviewFlow: f.reviewFlow, fullTests: f.fullTests };
  if (f.ciRunner !== null) gate.ciRunner = f.ciRunner;
  if (f.ciFallback !== null) gate.ciFallback = f.ciFallback;
  if (f.testGroups.length > 0) gate.testGroups = f.testGroups;
  if (f.requiredChecks.length > 0) gate.requiredChecks = f.requiredChecks;
  const review = { reviewers: f.reviewers, reviewSections: f.reviewSections, reviewKeyword: f.reviewKeyword, maxReviewRounds: f.maxReviewRounds };
  // 显式写了 0 的旧配置（keepZeroMinChars，由调用方按原始文件判断）保留这个 0：回滚时 toFlat 据此继续写出 0，旧版不会回到自己的默认字数
  if (f.reviewMinChars > 0 || (keepZeroMinChars && f.reviewMinChars === 0)) review.reviewMinChars = f.reviewMinChars;
  if (f.externalExecutors.length > 0) review.externalExecutors = f.externalExecutors;
  if (f.externalExclude.length > 0) review.externalExclude = f.externalExclude;
  // 环境选项只在有非默认值时才写：迁移旧配置不凭空多出一段
  const environment = {};
  if (JSON.stringify(f.ciOs) !== JSON.stringify(DEFAULTS.ciOs)) environment.ciOs = f.ciOs;
  if (f.session !== null) environment.session = f.session;
  if (f.parallel !== null) environment.parallel = f.parallel;
  return {
    profile: 2,
    modules: {
      gate,
      review,
      ...(Object.keys(environment).length > 0 ? { environment } : {}),
    },
    layout: { sourceGlobs, testGlobs, stages, topLevelAllowed },
    hygiene: { ...f.hygiene },
    rules: { reviewIgnore: f.reviewIgnore, commentMode: f.commentMode },
  };
}

/**
 * profile 结构 → 扁平配置（回滚到旧版本时使用）。旧版只认闸门字段；布局与巡检设置放进 _profile 段，
 * 旧版忽略它，再次升级时由 toProfile 恢复，所以回滚再升级不会丢失项目设置。
 */
export function toFlat(profile) {
  const eff = normalizeConfig(profile);
  const out = {};
  for (const k of FLAT_KEYS) out[k] = eff[k];
  // 旧版套件只认字数：默认的 0 不写出去，让旧版用它自己的默认值（回滚后恢复旧行为），显式写了正数的照常保留；
  // 项目显式写了 0（明确不要字数检查）的也保留：旧版同样按 0 不检查，删掉它会让旧版回到自己的默认字数，回滚后检查反而变严
  const explicit = isObject(profile?.modules?.review) ? profile.modules.review.reviewMinChars : undefined;
  if (out.reviewMinChars === 0 && explicit !== 0) delete out.reviewMinChars;
  out._profile = { layout: { stages: eff.layout.stages, topLevelAllowed: eff.layout.topLevelAllowed }, hygiene: eff.hygiene };
  return out;
}
