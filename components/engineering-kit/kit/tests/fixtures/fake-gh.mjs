// 假 gh 安装器（测试支持）：在临时目录里造一个名叫 gh 的可执行文件（node 的符号链接或副本）并返回子进程环境，
// 让通过 spawn 调用 "gh" 的套件脚本全程不碰网络、不依赖本机已登录的 gh。Windows 与 Linux 通用。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../helpers.mjs';

const PRELOAD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-gh-preload.cjs');
let binDir = null;

/** 每个测试文件只建一次 gh 可执行文件（Windows 上是 node.exe 的副本，较大）。 */
function ghBin() {
  if (binDir) return binDir;
  binDir = tmpDir('ekit-ghbin-');
  const target = path.join(binDir, process.platform === 'win32' ? 'gh.exe' : 'gh');
  if (process.platform === 'win32') fs.copyFileSync(process.execPath, target);
  else fs.symlinkSync(process.execPath, target);
  return binDir;
}

/**
 * 按设定造一份假 gh 的运行环境。cfg：{ prHead, runs: [{ databaseId, attempt, status, conclusion, name }],
 * artifacts: { '<运行号>': { '<产物内的相对路径>': '文本' } }（没列出的运行下载时报“没有产物”）, failOn: 'pr view' 之类 }。
 * 返回 { env, calls() }：env 给 spawnSync 的 env 选项；calls() 读出每次 gh 调用的参数数组。
 */
export function fakeGh(cfg) {
  const dir = tmpDir('ekit-fakegh-');
  const log = path.join(dir, 'calls.jsonl');
  const cfgFile = path.join(dir, 'cfg.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, log }));
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = `${ghBin()}${path.delimiter}${env[pathKey] ?? ''}`;
  env.EK_FAKE_GH = cfgFile;
  const opt = `--require "${PRELOAD.split(path.sep).join('/')}"`;
  env.NODE_OPTIONS = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${opt}` : opt;
  return {
    env,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}
