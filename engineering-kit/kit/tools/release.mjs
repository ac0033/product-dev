// 发布整包版本（源端工具）：检查 → 提交（只提交整包目录） → 打版本标签。不推送、不开 PR。
// 业务含义：每个整包版本都是源仓库里的一个标签（engineering-kit-vX.Y.Z），项目锁文件记录所装版本，
// 因而任何项目都能回滚到指定版本：node kit/sync.mjs --target <项目> --from-tag engineering-kit-vX.Y.Z
// 用法：node kit/tools/release.mjs [--check]     只检查，不提交
//       node kit/tools/release.mjs              检查、提交、打标签
import fs from 'node:fs';
import path from 'node:path';
import { git, repoRoot, isMain } from '../gate/lib.mjs';
import { loadBundle } from './bundle-lib.mjs';
import { DEFAULT_BUNDLE_DIR, defaultCheck } from './changeset.mjs';

/** 套件测试（与变更集应用时相同的检查，不含 changeset 测试以免递归）。 */
export const runKitTests = defaultCheck;

/**
 * 发布整包版本。返回 { version, tag, commit }（check 模式下只返回检查结果）。
 * 检查项：清单合法、VERSION 与清单一致、标签尚不存在、套件测试通过、整包目录的未提交改动只属于本目录。
 */
export function releaseBundle({ bundleDir = DEFAULT_BUNDLE_DIR, check = false, testRunner = runKitTests }) {
  const bundle = loadBundle(bundleDir);
  const version = bundle.bundleVersion;
  const kitVersion = fs.readFileSync(path.join(bundleDir, 'kit', 'VERSION'), 'utf8').trim();
  if (kitVersion !== version) throw new Error(`kit/VERSION（${kitVersion}）与 bundle.json（${version}）不一致`);
  const top = repoRoot(bundleDir);
  const tag = `engineering-kit-v${version}`;
  if (git(top, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]).ok) throw new Error(`标签 ${tag} 已存在，请先升级 bundleVersion`);
  const tests = testRunner(bundleDir);
  if (!tests.ok) throw new Error(`套件测试未通过，不能发布：\n${tests.output.slice(-2000)}`);
  if (check) return { version, tag, checked: true };

  const rel = path.relative(top, bundleDir).replace(/\\/g, '/');
  git(top, ['add', '--', rel]);
  const commit = git(top, ['commit', '-q', '-m', `release(engineering-kit): ${version}`, '--', rel]);
  if (!commit.ok) throw new Error(`提交失败：${(commit.err + commit.out).trim()}`);
  const sha = git(top, ['rev-parse', 'HEAD']).out.trim();
  const tagged = git(top, ['tag', '-a', tag, '-m', `engineering-kit ${version}`]);
  if (!tagged.ok) throw new Error(`打标签失败：${tagged.err.trim()}`);
  return { version, tag, commit: sha };
}

if (isMain(import.meta.url)) {
  try {
    const check = process.argv.includes('--check');
    const r = releaseBundle({ check });
    console.log(check ? `检查通过：${r.version}（将使用标签 ${r.tag}）` : `已发布 ${r.version}：标签 ${r.tag}，提交 ${r.commit.slice(0, 8)}（未推送）`);
  } catch (e) {
    console.error(`发布失败：${e.message}`);
    process.exit(1);
  }
}
