// 装配 DeepSeek Harness（DSH）用的 npm 包：dsh/ 里手写的清单和入口，加上只有一个入口的技能包。
// 业务含义：DSH 的“添加插件”只接受声明了 dsh.bundle 的 npm 包，包里要自带技能文件；
// 技能内容不另存一份，发布前由本脚本从插件成品装配，装配结果就是 npm publish 的目录。
// 用法：node tools/build-dsh-package.mjs <输出目录>   （目录不能已存在）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPortableSkill } from './build-portable-skill.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOURCE = path.join(ROOT, 'dsh');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export function buildDshPackage(destination) {
  const target = path.resolve(destination);
  if (fs.existsSync(target)) throw Object.assign(new Error('输出目录已存在：' + target), { code: 'EEXIST' });
  const manifest = json(path.join(SOURCE, 'package.json'));
  const pluginVersion = json(path.join(ROOT, 'plugin/.claude-plugin/plugin.json')).version;
  if (manifest.version !== pluginVersion) throw new Error(`dsh/package.json 的版本 ${manifest.version} 与插件版本 ${pluginVersion} 不一致`);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(target), '.dsh-package-build-'));
  try {
    fs.cpSync(SOURCE, staging, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(staging, 'LICENSE'));
    fs.copyFileSync(path.join(ROOT, 'plugin/THIRD_PARTY_NOTICES.md'), path.join(staging, 'THIRD_PARTY_NOTICES.md'));
    buildPortableSkill(path.join(staging, 'skills', 'product-dev'));
    fs.renameSync(staging, target);
    return target;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('用法：node tools/build-dsh-package.mjs <输出目录>');
  console.log(buildDshPackage(process.argv[2]));
}
