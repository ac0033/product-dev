// Product Dev 的 DeepSeek Harness（DSH）插件：把包里自带的技能注册进 DSH 的技能目录（ctx.skills）。
// 业务含义：装上这个包之后，DSH 的模型和 / 菜单里出现 product-dev 入口；内部技能、子代理任务书、
// 工程脚本和模板都在入口技能的目录里，由入口按相对路径读取，不单独出现在技能目录里。
// 只用 Node 内置模块，不需要构建。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 包里存放技能的目录：只认一层 <名称>/SKILL.md。 */
export const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url));
const PROVIDER = 'product-dev';
/** 随包提供的技能排在最后（DSH 的 bundled 档）：用户在项目或用户目录里放了同名技能时，用户那一份优先。 */
const RANK = 600;

/** 读出一个技能文件的名称、描述、调用范围和正文；文件头不合格时返回 null。 */
export function parseSkill(file) {
  const text = readFileSync(file, 'utf8');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return null;
  const field = (key) => (m[1].match(new RegExp(`^${key}:[ \\t]*(.+)$`, 'm')) || [])[1]?.trim().replace(/^(["'])(.*)\1$/, '$2');
  const name = field('name');
  const description = field('description');
  if (!name || !description) return null;
  return {
    name,
    description,
    invocation: { modelInvocable: field('disable-model-invocation') !== 'true', userInvocable: field('user-invocable') !== 'false' },
    content: text.slice(m[0].length),
  };
}

/** 列出目录下的全部技能。 */
export function readSkills(dir = SKILLS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const skillDir = join(dir, e.name);
      const file = join(skillDir, 'SKILL.md');
      const skill = existsSync(file) ? parseSkill(file) : null;
      return skill && { ...skill, dir: skillDir, file };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 供 ctx.skills 使用的技能来源：目录里列名称和描述，加载时再读正文，所以改了技能文件不用重启。 */
export function createSkillProvider(dir = SKILLS_DIR) {
  const summary = (s) => ({
    name: s.name,
    description: s.description,
    path: s.file,
    invocation: s.invocation,
    source: 'bundled',
    provider: PROVIDER,
    resourceBase: { kind: 'directory', path: s.dir },
  });
  return {
    name: PROVIDER,
    async list() {
      return readSkills(dir).map((s) => ({ ...summary(s), rank: RANK, locator: s.dir }));
    },
    async get(candidate) {
      const s = readSkills(dir).find((x) => x.dir === candidate.locator && x.name === candidate.name);
      return s ? { ...summary(s), content: s.content } : undefined;
    },
  };
}

/** Cordis 插件名。 */
export const name = 'product-dev';
/** 依赖 DSH 的技能注册服务。 */
export const inject = ['skills'];

/** 注册技能来源；插件被停用或卸载时，DSH 随插件的生命周期自动注销。 */
export function apply(ctx) {
  ctx.skills.registerProvider(() => createSkillProvider());
}
