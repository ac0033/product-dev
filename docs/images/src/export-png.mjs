// 把 archify 生成的 workflow HTML 导出成 PNG：本机 Chrome 无头模式加载页面，取浅色主题、关掉动画，截取图表的 SVG 区域。
// 用法：node export-png.mjs <in.html> <out.png> [目标像素宽，默认 1500]。Chrome 位置取环境变量 ARCHIFY_CHROME，没有时用 Windows 默认安装路径。
// 调试端口由 Chrome 自选（--remote-debugging-port=0），从自己的用户数据目录读 DevToolsActivePort，不会连到别的实例；整体有超时，出错也会关掉 Chrome 并删临时目录。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [,, inHtml, outPng, targetW = '1500'] = process.argv;
if (!inHtml || !outPng) { console.error('用法：node export-png.mjs <in.html> <out.png> [宽度]'); process.exit(2); }
const chrome = process.env.ARCHIFY_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TOTAL_MS = 60000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-export-'));
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${prof}`, '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let ws;
// 总时长超时：关掉 Chrome，等它释放用户数据目录里的文件后再删（与 finally 一样等 500 毫秒）。
const watchdog = setTimeout(async () => { console.error('导出失败：总时长超过 ' + TOTAL_MS / 1000 + ' 秒'); proc.kill(); await sleep(500); try { fs.rmSync(prof, { recursive: true, force: true }); } catch {} process.exit(1); }, TOTAL_MS);
// 启动失败（可执行文件不存在等）时 spawn 触发 error 事件：照样删临时目录后退出，不留未处理的异常。
proc.once('error', (e) => { console.error('导出失败：无法启动 Chrome（' + chrome + '）：' + e.message + '；可用环境变量 ARCHIFY_CHROME 指定路径'); clearTimeout(watchdog); try { fs.rmSync(prof, { recursive: true, force: true }); } catch {} process.exit(1); });

// 等条件成立，最多 limitMs；超时抛错而不是继续。
async function until(what, fn, limitMs) {
  const end = Date.now() + limitMs;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch {}
    if (Date.now() > end) throw new Error(`等待超时：${what}`);
    await sleep(100);
  }
}

// 取图表 SVG 内容的外接矩形（页面坐标）；排除背景大框与定义区，四周留 14 单位边距。
const RECT_JS = `(function(){
  var s = document.querySelector('.diagram-container svg'); s.scrollIntoView();
  var r = s.getBoundingClientRect(), vb = s.viewBox.baseVal, k = r.width / vb.width;
  var boxes = Array.from(s.querySelectorAll('rect,path,text,line,polyline,circle')).map(function(c){
    var q = c.getBoundingClientRect();
    return q.width && q.height && q.width < r.width * 0.97 && q.height < r.height * 0.97 && !c.closest('defs,pattern,clipPath,mask')
      ? { x: (q.x - r.x) / k, y: (q.y - r.y) / k, width: q.width / k, height: q.height / k } : null;
  }).filter(Boolean);
  var lim = Math.max.apply(0, Array.from(s.querySelectorAll('rect')).map(function(c){
    var q = c.getBoundingClientRect();
    return q.width > r.width * 0.8 && q.height < r.height * 0.97 ? (q.bottom - r.y) / k : 0;
  }));
  boxes = boxes.filter(function(q){ return q.y < lim; });
  var x0 = Math.min.apply(0, boxes.map(function(q){ return q.x; })), y0 = Math.min.apply(0, boxes.map(function(q){ return q.y; }));
  var x1 = Math.max.apply(0, boxes.map(function(q){ return q.x + q.width; })), y1 = Math.max.apply(0, boxes.map(function(q){ return q.y + q.height; }));
  var m = 14;
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(vb.width, x1 + m); y1 = Math.min(vb.height, y1 + m);
  return { x: r.x + scrollX + x0 * k, y: r.y + scrollY + y0 * k, w: (x1 - x0) * k, h: (y1 - y0) * k };
})()`;

try {
  const port = Number((await until('DevToolsActivePort', () => fs.readFileSync(path.join(prof, 'DevToolsActivePort'), 'utf8').split('\n')[0], 15000)));
  const targets = await until('页面目标', async () => { const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); return t.some(x => x.type === 'page') && t; }, 15000);
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('调试连接失败')); });
  let id = 0; const pend = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; const t = setTimeout(() => rej(new Error(`调用超时：${method}`)), 20000);
    pend.set(i, m => { clearTimeout(t); res(m); }); ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async expr => {
    const r = (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result;
    if (r?.exceptionDetails) throw new Error('页面脚本出错：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r?.result?.value;
  };

  await send('Emulation.setDeviceMetricsOverride', { width: 1800, height: 1400, deviceScaleFactor: 1, mobile: false });
  await send('Page.enable');
  await send('Page.navigate', { url: pathToFileURL(path.resolve(inHtml)).href });
  // 就绪条件：文档加载完、字体就绪、图表 SVG 已有内容。
  await until('页面就绪', () => ev(`document.readyState === 'complete' && !!document.querySelector('.diagram-container svg rect, .diagram-container svg text')`), 20000);
  await ev(`document.fonts ? document.fonts.ready.then(function(){ return true; }) : true`);
  await ev(`document.documentElement.setAttribute('data-theme','light')`);
  await ev(`(function(){var s=document.createElement('style');s.textContent='*{animation:none!important;transition:none!important}';document.head.appendChild(s)})()`);
  // 关动画后等两帧让样式落地。
  await ev(`new Promise(function(r){ requestAnimationFrame(function(){ requestAnimationFrame(function(){ r(true); }); }); })`);

  const rect = await ev(RECT_JS);
  if (!rect || ![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) || rect.w <= 0 || rect.h <= 0) throw new Error('裁剪区域无效：' + JSON.stringify(rect));
  const scale = Number(targetW) / rect.w;
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('目标宽度无效：' + targetW);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale } });
  if (!shot.result?.data) throw new Error('截图失败：' + JSON.stringify(shot.error || shot));
  fs.writeFileSync(outPng, Buffer.from(shot.result.data, 'base64'));
  console.log(`已导出 ${outPng}（裁剪 ${Math.round(rect.w)}x${Math.round(rect.h)}，输出宽 ${targetW}）`);
} catch (e) {
  console.error('导出失败：' + e.message);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  try { ws?.close(); } catch {}
  proc.kill();
  await sleep(500);
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
}
