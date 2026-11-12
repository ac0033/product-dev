// 把 archify 生成的 workflow HTML 导出成 PNG：本机 Chrome 无头模式加载页面，取浅色主题、关掉动画，截取图表的 SVG 区域。
// 用法：node export-png.mjs <in.html> <out.png> [目标像素宽，默认 1500]。Chrome 位置取环境变量 ARCHIFY_CHROME，没有时用 Windows 默认安装路径。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path'; import { pathToFileURL } from 'node:url';
const [,, inHtml, outPng, targetW = '1500'] = process.argv;
const chrome = process.env.ARCHIFY_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = 9333 + Math.floor(Math.random() * 500);
const prof = path.join(os.tmpdir(), 'archify-export-' + port);
const p = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let targets;
for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.some(t => t.type === 'page')) break; } catch {} await sleep(200); }
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send('Emulation.setDeviceMetricsOverride', { width: 1800, height: 1400, deviceScaleFactor: 1, mobile: false });
await send('Page.enable');
await send('Page.navigate', { url: pathToFileURL(path.resolve(inHtml)).href });
await sleep(2500);
await ev(`document.documentElement.setAttribute('data-theme','light')`);
await ev(`(function(){var s=document.createElement('style');s.textContent='*{animation:none!important;transition:none!important}';document.head.appendChild(s)})()`);
await sleep(500);
const rect = await ev(`(function(){var s=document.querySelector('.diagram-container svg');s.scrollIntoView();var r=s.getBoundingClientRect();var vb=s.viewBox.baseVal;var k=r.width/vb.width;var b=Array.from(s.querySelectorAll('rect,path,text,line,polyline,circle')).map(function(c){var q=c.getBoundingClientRect();return q.width&&q.height&&q.width<r.width*0.97&&q.height<r.height*0.97&&!c.closest('defs,pattern,clipPath,mask')?{x:(q.x-r.x)/k,y:(q.y-r.y)/k,width:q.width/k,height:q.height/k}:null}).filter(Boolean);var lim=Math.max.apply(0,Array.from(s.querySelectorAll('rect')).map(function(c){var q=c.getBoundingClientRect();return q.width>r.width*0.8&&q.height<r.height*0.97?(q.bottom-r.y)/k:0}));b=b.filter(function(q){return q.y<lim});var x0=Math.min.apply(0,b.map(function(q){return q.x})),y0=Math.min.apply(0,b.map(function(q){return q.y})),x1=Math.max.apply(0,b.map(function(q){return q.x+q.width})),y1=Math.max.apply(0,b.map(function(q){return q.y+q.height}));var m=14;x0=Math.max(0,x0-m);y0=Math.max(0,y0-m);x1=Math.min(vb.width,x1+m);y1=Math.min(vb.height,y1+m);return {x:r.x+scrollX+x0*k,y:r.y+scrollY+y0*k,w:(x1-x0)*k,h:(y1-y0)*k,vw:vb.width,vh:vb.height}})()`);
const scale = Number(targetW) / rect.w;
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale } });
fs.writeFileSync(outPng, Buffer.from(shot.result.data, 'base64'));
ws.close(); p.kill();
await sleep(500);
try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
