// 技术栈预设：开工前一次选定，写入项目配置（测试命令、源码与测试范围）并生成最小脚手架（包清单、忽略规则）。
// 业务含义：规则与结构要在项目第一天就配好，所以预设在首次安装时生效；之后配置由项目自己维护，同步不再覆盖。
// 预设只决定“怎么测、哪里是源码”，不写任何业务代码。脚手架文件只在不存在时创建，已有文件一律保留。
import path from 'node:path';

/** 预设表。字段：gate（写入 modules.gate 的字段）、layout（源码与测试的 glob）、scaffold（项目名 → 脚手架文件）。 */
export const PRESETS = {
  ts: {
    name: 'ts',
    description: 'TypeScript：Node 内置测试运行器直接运行 .test.ts（需要 Node 22.6 以上，本套件在 Node 24 上验证）',
    gate: { base: 'auto', testCommand: 'npm test', testEnv: {} },
    layout: { sourceGlobs: ['src/**/*.ts'], testGlobs: ['tests/**/*.test.ts'] },
    scaffold: (name) => ({
      'package.json': `${JSON.stringify({ name, private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
      '.gitignore': 'node_modules/\ndist/\n',
    }),
  },
  python: {
    name: 'python',
    description: 'Python：pytest 运行测试，源码放在 src/，测试放在 tests/（需要 Python 3.12 以上与 pytest）',
    gate: { base: 'auto', testCommand: 'python -m pytest -q -p no:cacheprovider', testEnv: {} },
    layout: { sourceGlobs: ['src/**/*.py'], testGlobs: ['tests/**/*.py'] },
    scaffold: (name) => ({
      'pyproject.toml': [
        '[project]',
        `name = "${name}"`,
        'version = "0.1.0"',
        'requires-python = ">=3.12"',
        '',
        '[tool.pytest.ini_options]',
        'testpaths = ["tests"]',
        'pythonpath = ["src"]',
        '',
      ].join('\n'),
      '.gitignore': '__pycache__/\n.pytest_cache/\n.venv/\n',
    }),
  },
};

/** 由目录名得到合法的包名（小写字母、数字与连字符）。 */
export function projectName(dir) {
  const base = path.basename(path.resolve(dir)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return base || 'project';
}

/**
 * 把预设应用到 profile 结构的配置上，返回新对象（不改动入参）。
 * 只覆盖 modules.gate 中的技术栈字段，以及 layout 中的源码与测试范围；其余字段保持模板原样。
 */
export function applyPreset(profile, preset) {
  const out = JSON.parse(JSON.stringify(profile));
  out.modules = out.modules || {};
  out.modules.gate = { ...(out.modules.gate || {}), ...preset.gate };
  out.layout = { ...(out.layout || {}), sourceGlobs: [...preset.layout.sourceGlobs], testGlobs: [...preset.layout.testGlobs] };
  return out;
}

/** 预设的脚手架文件：{ 相对路径: 内容 }。 */
export function scaffoldFiles(preset, name) {
  return preset.scaffold(name);
}
