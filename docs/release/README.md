# 发布维护

1. 从 main 开分支，更新两份插件清单、dsh/package.json 和安装文档中的版本。
2. 运行 node tools/build-plugin.mjs 和 node --test evals/*.test.mjs，提交并通过 PR 的跨平台 CI 与双审后合并。
3. 在同一个合并提交创建 v<版本> 标签。
4. 先清空 dist/：打包脚本要求输出目录不存在，留着上次的 dist/ 会直接报错，也会把旧产物混进核对；dist/ 被 git 忽略，删除前看一眼里面没有要保留的文件（PowerShell：Remove-Item -Recurse -Force dist；bash：rm -rf dist）。然后运行 node tools/package-release.mjs dist，按 dist/SHA256SUMS.txt 核对产物。
5. 发布 dist/dsh-product-dev-<版本>.tgz 到 npm；GitHub Release 附 product-dev-plugin.zip、product-dev-skill.zip、npm tarball 和 SHA256SUMS.txt。
6. 在 ac0033/skills 的两份市场清单同步版本和 git-subdir ref，回读公开标签、资产、npm 和市场并做隔离新装及旧版升级验收。

发布记录：[0.3.2](2026-11-13-0.3.2.md)、[0.3.1](2026-11-13-0.3.1.md)、[0.3.0](2026-11-12-0.3.0.md)、[独立仓库迁移](2026-11-11-migration.md)。历史验证保留在 evals/runs/；其中旧仓库路径和链接描述记录时的现场。
