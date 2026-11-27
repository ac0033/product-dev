// 假 gh 的预加载脚本（测试支持，不是被测代码）：测试把 node 可执行文件以 gh 的名字放进 PATH，
// 套件脚本 spawn "gh" 时实际运行的是 node，并由 NODE_OPTIONS 预加载本文件；按 argv0 判断自己是不是被当作 gh 调用，不是就什么都不做。
// 行为由环境变量 EK_FAKE_GH 指向的 JSON 文件决定：{ prHead, runs, artifacts, failOn, log }。每次调用的参数追加写进 log（JSON 行）。
const fs = require('node:fs');
const path = require('node:path');

const me = path.basename(process.argv0 || '').replace(/\.exe$/i, '');
if (me === 'gh' && process.env.EK_FAKE_GH) {
  const cfg = JSON.parse(fs.readFileSync(process.env.EK_FAKE_GH, 'utf8'));
  // node 把第一个非选项参数当脚本路径并转成绝对路径，这里还原成原来的子命令名
  const args = [path.basename(process.argv[1]), ...process.argv.slice(2)];
  if (cfg.log) fs.appendFileSync(cfg.log, `${JSON.stringify(args)}\n`);
  const fail = (msg) => { process.stderr.write(`${msg}\n`); process.exit(1); };
  const sub = `${args[0]} ${args[1]}`;
  if (cfg.failOn && sub === cfg.failOn) fail(`假 gh：${sub} 按设定失败`);
  const opt = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
  if (sub === 'pr view') {
    process.stdout.write(`${JSON.stringify({ headRefOid: cfg.prHead })}\n`);
  } else if (sub === 'run list') {
    process.stdout.write(`${JSON.stringify(cfg.runs || [])}\n`);
  } else if (sub === 'run download') {
    const id = String(args[2]);
    const dir = opt('--dir');
    const files = (cfg.artifacts || {})[id];
    if (!files) fail('no valid artifacts found to download');
    // 用 --pattern 下载时 gh 为每个产物建一个子目录（产物名）；用 --name 下载时文件直接放进 --dir
    const named = opt('--name') !== null;
    for (const [art, content] of Object.entries(files)) {
      const target = named ? path.join(dir, art) : path.join(dir, ...art.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
  } else {
    fail(`假 gh：不认识的调用 ${args.join(' ')}`);
  }
  process.exit(0);
}
