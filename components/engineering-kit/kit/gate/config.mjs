// 项目配置（engineering.config.json）的 profile 结构与展开。业务含义：
//   项目配置是唯一由项目自己维护的文件，结构分四段，便于升级时只改动套件认可的字段：
//     modules  —— 模块参数：gate（基准分支、测试命令、环境变量、锁时长、复审流程 reviewFlow）、review（复审者名单、字数、结论关键词）
//     layout   —— 目录布局：源文件与测试的 glob、阶段目录、允许的顶层目录
//     hygiene  —— 巡检参数：禁用文件名片段、草稿超期天数、记录类目录、合法状态值
//     rules    —— 规则：不计入闸门的文档（reviewIgnore；项目配置、豁免表、套件脚本除外，永远计入）、注释检查模式（commentMode）
//   这里只做结构展开。闸门运行时 base 与判定策略字段（reviewIgnore、reviewFlow、reviewers、reviewMinChars、reviewKeyword）
//   的生效值不取工作区，而取主干或基准提交上的配置，见 lib.mjs 的 loadConfig。
//   闸门内部只使用“扁平”字段（FLAT_KEYS），由 normalizeConfig 展开；旧版扁平配置仍可读取，便于回滚。
// 同步器通过 toProfile / toFlat 在两种结构之间转换，保证回滚到旧版本时配置格式也随之回退。

/** 闸门使用的扁平字段名（与旧版 engineering.config.json 相同）。 */
export const FLAT_KEYS = [
  'base', 'sourceGlobs', 'testGlobs', 'reviewIgnore', 'commentMode', 'testCommand', 'testEnv',
  'reviewers', 'reviewMinChars', 'reviewKeyword', 'lockMaxAgeMinutes', 'reviewFlow',
];

/** 扁平字段的缺省值。 */
export const DEFAULTS = {
  base: 'auto',
  sourceGlobs: [],
  testGlobs: [],
  reviewIgnore: ['**/*.md', 'docs/**'],
  commentMode: 'header+exports',
  testCommand: 'npm test',
  testEnv: {},
  reviewers: ['product-dev:code-reviewer', 'feature-dev:code-reviewer', '/code-review', 'general-purpose'],
  reviewMinChars: 200,
  reviewKeyword: '结论',
  lockMaxAgeMinutes: 90,
  reviewFlow: 'pre-push',
};

/** 复审流程的合法取值：pre-push（推送前单项复审）或 pr（CI 通过后对 PR 最终提交做代码复审与一致性审，经 merge.mjs 合并）。 */
export const REVIEW_FLOWS = ['pre-push', 'pr'];

/** 目录布局与巡检的缺省值（profile 的 layout、hygiene 段）。 */
export const LAYOUT_DEFAULTS = {
  stages: ['00-总览', '01-需求', '02-原型', '03-架构', '04-开发', '05-测试', '06-发布'],
  topLevelAllowed: ['docs', 'src', 'tests', 'scripts', 'config', 'templates', '.github', '.claude'],
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
  return eff;
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
    reviewers: review.reviewers ?? DEFAULTS.reviewers,
    reviewMinChars: review.reviewMinChars ?? DEFAULTS.reviewMinChars,
    reviewKeyword: review.reviewKeyword ?? DEFAULTS.reviewKeyword,
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
 */
export function toProfile(flat) {
  const f = normalizeConfig(flat);
  const { sourceGlobs, testGlobs, stages, topLevelAllowed } = { ...f.layout, sourceGlobs: f.sourceGlobs, testGlobs: f.testGlobs };
  return {
    profile: 2,
    modules: {
      gate: { base: f.base, testCommand: f.testCommand, testEnv: f.testEnv, lockMaxAgeMinutes: f.lockMaxAgeMinutes, reviewFlow: f.reviewFlow },
      review: { reviewers: f.reviewers, reviewMinChars: f.reviewMinChars, reviewKeyword: f.reviewKeyword },
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
  out._profile = { layout: { stages: eff.layout.stages, topLevelAllowed: eff.layout.topLevelAllowed }, hygiene: eff.hygiene };
  return out;
}
