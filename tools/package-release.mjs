// 从干净的已提交源码构建同一版本的原生插件、便携技能和 npm 包，并生成 SHA256SUMS.txt。
// 用法：node tools/package-release.mjs <不存在的输出目录>；不发布、不使用认证信息。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildDshPackage } from './build-dsh-package.mjs';
import { buildPortableSkill } from './build-portable-skill.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = process.argv[2] && path.resolve(process.argv[2]);
if (!out || fs.existsSync(out)) throw new Error('请提供不存在的输出目录');
const git = (...args) => execFileSync('git', ['-C', root, ...args], {encoding:'utf8'});
if (git('status','--porcelain','--untracked-files=normal').trim()) throw new Error('发布必须从干净的已提交源码构建');
const json = p => JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const version = json('dsh/package.json').version;
for (const p of ['plugin/.claude-plugin/plugin.json','plugin/.codex-plugin/plugin.json']) if (json(p).version !== version) throw new Error('分发版本不一致');
fs.mkdirSync(out,{recursive:true});
git('archive','--format=zip','--prefix=product-dev/','--output='+path.join(out,'product-dev-plugin.zip'),'HEAD:plugin');
const portableRoot = path.join(out,'portable');
buildPortableSkill(path.join(portableRoot,'product-dev'));
// 用临时 git index 生成跨平台 ZIP，显式保留上游脚本的可执行位。
execFileSync('git',['init','-q',portableRoot]);
const pg = (...args) => execFileSync('git',['-C',portableRoot,...args],{encoding:'utf8'});
pg('config','core.autocrlf','false'); pg('config','core.longpaths','true'); pg('add','.');
for (const part of json('plugin/BUILD.lock.json').parts) for (const file of part.executable || []) pg('update-index','--chmod=+x','product-dev/references/product-dev/'+part.dest+'/'+file);
const tree = pg('write-tree').trim();
pg('archive','--format=zip','--output='+path.join(out,'product-dev-skill.zip'),tree);
const npmDir = buildDshPackage(path.join(out,'dsh-product-dev'));
const npmArgs = ['pack','--json','--ignore-scripts'];
const packed = process.platform === 'win32'
  ? execFileSync(process.execPath,[path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),...npmArgs],{cwd:npmDir,encoding:'utf8'})
  : execFileSync('npm',npmArgs,{cwd:npmDir,encoding:'utf8'});
const filename = JSON.parse(packed)[0].filename;
fs.renameSync(path.join(npmDir,filename),path.join(out,filename));
const files = ['product-dev-plugin.zip','product-dev-skill.zip',filename];
fs.writeFileSync(path.join(out,'SHA256SUMS.txt'),files.map(f=>crypto.createHash('sha256').update(fs.readFileSync(path.join(out,f))).digest('hex')+'  '+f).join('\n')+'\n');
console.log(JSON.stringify({version,commit:git('rev-parse','HEAD').trim(),files},null,2));
