// 把原生插件打成只注册一个入口的 Agent Skills 目录，保留工作流依赖。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const plugin = fileURLToPath(new URL('../plugin/', import.meta.url));
const payloadPath = 'references/product-dev';
const skillFilename = 'SKILL.md';
const internalFilename = 'WORKFLOW.md';

export function buildPortableSkill(destination) {
  const target = path.resolve(destination);
  if (path.basename(target) !== 'product-dev') throw new Error('输出目录名必须是 product-dev');
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, '.product-dev-build-'));
  try {
    const payload = path.join(staging, payloadPath);
    fs.mkdirSync(payload, { recursive: true });
    for (const part of ['skills', 'agents', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'BUILD.lock.json']) {
      fs.cpSync(path.join(plugin, part), path.join(payload, part), {
        recursive: true,
        filter: (file) => {
          if (fs.lstatSync(file).isSymbolicLink()) throw new Error('便携包不能包含符号链接：' + file);
          return true;
        },
      });
    }

    const files = fs.readdirSync(payload, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(entry.parentPath, entry.name));
    const entryFile = path.join(payload, 'skills', 'product-dev', skillFilename);
    const frontmatter = fs.readFileSync(entryFile, 'utf8').match(/^---\r?\n[\s\S]*?\r?\n---(?=\r?\n)/)?.[0];
    if (!frontmatter) throw new Error('入口技能缺少有效的文件头');

    const internal = new Set(files.filter((file) => /^skill\.md$/i.test(path.basename(file))));
    // 只重写包内实际存在的技能路径，保留上游链接、引用和示例。
    for (const file of files.filter((file) => path.extname(file) === '.md')) {
      const text = fs.readFileSync(file, 'utf8');
      const rewritten = text.replace(/(\]\(|`)([^\s()\[\]`#]*\bSKILL\.md)(?=[)#`])/g, (match, prefix, reference) => {
        const referenced = path.resolve(path.dirname(file), reference);
        if (!internal.has(referenced)) return match;
        return prefix + reference.slice(0, -skillFilename.length) + internalFilename;
      });
      if (rewritten !== text) fs.writeFileSync(file, rewritten);
    }
    for (const file of internal) {
      fs.renameSync(file, path.join(path.dirname(file), internalFilename));
    }

    const entryPath = payloadPath + '/skills/product-dev/' + internalFilename;
    fs.writeFileSync(path.join(staging, skillFilename), frontmatter + '\n\n' + [
      '# Product Dev',
      '',
      '先读取[完整工作流](' + entryPath + ')，按其中的恢复现场和分流步骤推进。工作流里的「插件根」指本技能目录下的 `' + payloadPath + '`。',
      '',
      '内部技能随包提供。按完整工作流中的相对链接读取相应的 `' + internalFilename + '`。遇到指向内部技能的文件名约定时，也用同目录的 `' + internalFilename + '`。规则、授权和验收条件仍按完整工作流执行。',
      '',
      '按宿主提供的工具执行。缺少终端、浏览器或独立复审所需的子代理时，遵循完整工作流的宿主差异处理，说明受影响的阶段。',
      '',
    ].join('\n'));
    if (fs.existsSync(target)) {
      throw Object.assign(new Error('输出目录已存在：' + target), { code: 'EEXIST' });
    }
    fs.renameSync(staging, target);
    return target;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('用法：node product-dev/tools/build-portable-skill.mjs <输出路径>/product-dev');
  console.log(buildPortableSkill(process.argv[2]));
}
