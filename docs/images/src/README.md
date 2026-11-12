# 导图源文件

`delivery.png`、`feature.png`、`new-project.png`、`bug-fix.png` 由本目录的 archify workflow JSON 生成（archify 随插件分发，位于 `plugin/skills/archify/`）。

1. 校验并渲染成 HTML：`node plugin/skills/archify/bin/archify.mjs finalize workflow docs/images/src/<名>.workflow.json <临时目录>/<名>.html --quality showcase --json`（`meta.output` 只是占位，实际输出到命令行给的路径；重跑前先删掉旧的 `<名>.*` 证据文件）。
2. 导出 PNG：`node docs/images/src/export-png.mjs <临时目录>/<名>.html docs/images/<名>.png 1500`（用本机 Chrome 无头模式截取图表，第三个参数是输出像素宽度；Chrome 不在 Windows 默认路径时设环境变量 `ARCHIFY_CHROME`）。
3. 改了步骤名要同步 `evals/entry.test.mjs` 的 STEPS，图上节点名须与之逐字一致。

`new-project.workflow.json`、`bug-fix.workflow.json` 是 2026-11-13 补的可编辑源：步骤、连线与旧 PNG 一致，布局和配色按 archify 重新生成，与旧 PNG 略有差别；两张 PNG 本身没有替换，要换时按上面两步重新生成（`new-project` 导出宽度 1000，`bug-fix` 1500）。
