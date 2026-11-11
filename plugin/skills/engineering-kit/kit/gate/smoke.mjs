// 冒烟测试：安装或升级后运行，确认项目里的闸门文件能加载、项目配置能展开、巡检能运行。
// 业务含义：原子同步的最后一道检查。冒烟失败时同步会整体回滚，所以这里只检查“能不能用”，不检查项目业务。
// 用法：node scripts/engineering/gate/smoke.mjs [--root <项目根>]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMain } from './lib.mjs';

/** 运行冒烟，返回问题列表（空数组表示通过）。 */
export async function runSmoke(root) {
  const problems = [];
  const gateDir = path.join(root, 'scripts', 'engineering', 'gate');
  if (!fs.existsSync(gateDir)) return [`缺少 ${gateDir}`];
  for (const f of fs.readdirSync(gateDir).filter((n) => n.endsWith('.mjs')).sort()) {
    try {
      await import(pathToFileURL(path.join(gateDir, f)).href);
    } catch (e) {
      problems.push(`${f} 无法加载：${e.message}`);
    }
  }
  try {
    const lib = await import(pathToFileURL(path.join(gateDir, 'lib.mjs')).href);
    lib.loadConfig(root); // 配置必须能展开（旧版扁平配置与 profile 都可以）
  } catch (e) {
    problems.push(`配置无法加载：${e.message}`);
  }
  // 巡检只在该版本带有 hygiene.mjs 时检查（旧版本没有）
  if (fs.existsSync(path.join(gateDir, 'hygiene.mjs'))) try {
    const hyg = await import(pathToFileURL(path.join(gateDir, 'hygiene.mjs')).href);
    const rep = hyg.runHygiene(root);
    if (!rep || typeof rep.findings !== 'object') problems.push('巡检没有返回结果');
  } catch (e) {
    problems.push(`巡检无法运行：${e.message}`);
  }
  return problems;
}

if (isMain(import.meta.url)) {
  const i = process.argv.indexOf('--root');
  const root = path.resolve(i >= 0 ? process.argv[i + 1] : process.cwd());
  const problems = await runSmoke(root);
  if (problems.length > 0) {
    console.error(`冒烟测试失败：\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('冒烟测试通过');
}
