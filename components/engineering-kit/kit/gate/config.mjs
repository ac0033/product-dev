// 项目配置（engineering.config.json）的 profile 结构与展开。业务含义：
//   项目配置是唯一由项目自己维护的文件，结构分四段，便于升级时只改动套件认可的字段：
//     modules  —— 模块参数：gate（基准分支、测试命令、环境变量、测试分组 testGroups、锁时长、复审流程 reviewFlow、必需检查 requiredChecks）、
//                 review（复审者名单、报告必需的节 reviewSections、可选的最少字数 reviewMinChars、结论关键词、复审轮次上限 maxReviewRounds、允许的外部复审执行器 externalExecutors、外发前追加排除 externalExclude）
//     layout   —— 目录布局：源文件与测试的 glob、阶段目录、允许的顶层目录
//     hygiene  —— 巡检参数：禁用文件名片段、草稿超期天数、记录类目录、合法状态值
//     rules    —— 规则：不计入闸门的文档（reviewIgnore；项目配置、豁免表、套件脚本除外，永远计入）、注释检查模式（commentMode）
//   这里只做结构展开与取值校验。闸门运行时 base 与判定策略字段（reviewIgnore、reviewFlow、requiredChecks、reviewers、reviewMinChars、reviewSections、reviewKeyword、maxReviewRounds、externalExecutors、externalExclude）
//   的生效值不取工作区，而取主干或基准提交上的配置，见 lib.mjs 的 loadConfig。
//   闸门内部只使用“扁平”字段（FLAT_KEYS），由 normalizeConfig 展开；旧版扁平配置仍可读取，便于回滚。
// 同步器通过 toProfile / toFlat 在两种结构之间转换，保证回滚到旧版本时配置格式也随之回退。

/** 闸门使用的扁平字段名（与旧版 engineering.config.json 相同）。 */
export const FLAT_KEYS = [
  'base', 'sourceGlobs', 'testGlobs', 'reviewIgnore', 'commentMode', 'testCommand', 'testEnv',
  'reviewers', 'reviewMinChars', 'reviewSections', 'reviewKeyword', 'lockMaxAgeMinutes', 'reviewFlow', 'testGroups', 'maxReviewRounds', 'requiredChecks',
  'externalExecutors', 'externalExclude',
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
};

/** 复审流程的合法取值：pre-push（推送前复审，推送核对只要求代码复审）或 pr（对 PR 最终提交做代码复审与一致性审：复审可以与 CI 并行开始；CI 全部通过后才登记、合并，经 merge.mjs 合并）。 */
export const REVIEW_FLOWS = ['pre-push', 'pr'];

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

/** 展开两种结构（取值校验由 normalizeConfig 统一做）。 */
function expand(raw) {
  if (!isObject(raw)) throw new Error('engineering.config.json 必须是 JSON 对象');
  if (raw.profile === undefined) {
    // 旧版扁平结构：原样使用，缺省值补齐；_profile 段（回滚时保存的 profile 专有设置）同样生效
    const prof = isObject(raw._profile) ? raw._profile : {};
    return {
      ...DEFAULTS,
      ...raw,
      layout: { ...LAYOUT_DEFAULTS, ...(prof.layout || {}), sourceGlobs: raw.sourceGlobs ?? DEFAULTS.sourceGlobs, testGlobs: raw.testGlobs ?? DEFAULTS.testGlobs },
      hygiene: { ...HYGIENE_DEFAULTS, ...(prof.hygiene || {}) },
    };
  }
  if (raw.profile !== 2) throw new Error(`不支持的配置 profile 版本：${raw.profile}（当前只认 2）`);
  const modules = section(raw, 'modules');
  const gate = isObject(modules.gate) ? modules.gate : (modules.gate === undefined ? {} : (() => { throw new Error('engineering.config.json 的 modules.gate 必须是对象'); })());
  const review = isObject(modules.review) ? modules.review : (modules.review === undefined ? {} : (() => { throw new Error('engineering.config.json 的 modules.review 必须是对象'); })());
  const layout = section(raw, 'layout');
  const hygiene = section(raw, 'hygiene');
  const rules = section(raw, 'rules');
  const lay = { ...LAYOUT_DEFAULTS, ...layout };
  const hyg = { ...HYGIENE_DEFAULTS, ...hygiene };
  return {
    base: gate.base ?? DEFAULTS.base,
    testCommand: gate.testCommand ?? DEFAULTS.testCommand,
    testEnv: gate.testEnv ?? DEFAULTS.testEnv,
    lockMaxAgeMinutes: gate.lockMaxAgeMinutes ?? DEFAULTS.lockMaxAgeMinutes,
    reviewFlow: gate.reviewFlow ?? DEFAULTS.reviewFlow,
    testGroups: gate.testGroups ?? DEFAULTS.testGroups,
    requiredChecks: gate.requiredChecks ?? DEFAULTS.requiredChecks,
    reviewers: review.reviewers ?? DEFAULTS.reviewers,
    reviewMinChars: review.reviewMinChars ?? DEFAULTS.reviewMinChars,
    reviewSections: review.reviewSections ?? DEFAULTS.reviewSections,
    reviewKeyword: review.reviewKeyword ?? DEFAULTS.reviewKeyword,
    maxReviewRounds: review.maxReviewRounds ?? DEFAULTS.maxReviewRounds,
    externalExecutors: review.externalExecutors ?? DEFAULTS.externalExecutors,
    externalExclude: review.externalExclude ?? DEFAULTS.externalExclude,
    sourceGlobs: lay.sourceGlobs ?? DEFAULTS.sourceGlobs,
    testGlobs: lay.testGlobs ?? DEFAULTS.testGlobs,
    reviewIgnore: rules.reviewIgnore ?? DEFAULTS.reviewIgnore,
    commentMode: rules.commentMode ?? DEFAULTS.commentMode,
    layout: lay,
    hygiene: hyg,
  };
}

/**
 * 扁平配置 → profile 结构（同步器写入新格式时使用）。扁平结构里 _profile 段保存的布局与巡检设置原样恢复。
 * 测试分组、必需检查名、最少字数和外部复审的两项是可选项：没有时不写，迁移旧配置不凭空多出一项。
 */
export function toProfile(flat) {
  const f = normalizeConfig(flat);
  const { sourceGlobs, testGlobs, stages, topLevelAllowed } = { ...f.layout, sourceGlobs: f.sourceGlobs, testGlobs: f.testGlobs };
  const gate = { base: f.base, testCommand: f.testCommand, testEnv: f.testEnv, lockMaxAgeMinutes: f.lockMaxAgeMinutes, reviewFlow: f.reviewFlow };
  if (f.testGroups.length > 0) gate.testGroups = f.testGroups;
  if (f.requiredChecks.length > 0) gate.requiredChecks = f.requiredChecks;
  const review = { reviewers: f.reviewers, reviewSections: f.reviewSections, reviewKeyword: f.reviewKeyword, maxReviewRounds: f.maxReviewRounds };
  if (f.reviewMinChars > 0) review.reviewMinChars = f.reviewMinChars;
  if (f.externalExecutors.length > 0) review.externalExecutors = f.externalExecutors;
  if (f.externalExclude.length > 0) review.externalExclude = f.externalExclude;
  return {
    profile: 2,
    modules: {
      gate,
      review,
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
  // 旧版套件只认字数：默认的 0 不写出去，让旧版用它自己的默认值（回滚后恢复旧行为），显式写了正数的照常保留
  if (out.reviewMinChars === 0) delete out.reviewMinChars;
  out._profile = { layout: { stages: eff.layout.stages, topLevelAllowed: eff.layout.topLevelAllowed }, hygiene: eff.hygiene };
  return out;
}
