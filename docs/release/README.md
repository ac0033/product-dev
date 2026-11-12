# 发布维护

1. 从 main 开分支，更新两份插件清单、dsh/package.json 和安装文档中的版本。
2. 运行 node tools/build-plugin.mjs 和 node --test evals/*.test.mjs，提交并通过 PR 的跨平台 CI 与双审后合并。
3. 在同一个合并提交创建 v<版本> 标签，运行 node tools/package-release.mjs dist，按 dist/SHA256SUMS.txt 核对产物。
4. 发布 dist/dsh-product-dev-<版本>.tgz 到 npm；GitHub Release 附 product-dev-plugin.zip、product-dev-skill.zip、npm tarball 和 SHA256SUMS.txt。
5. 在 ac0033/skills 的两份市场清单同步版本和 git-subdir ref，回读公开标签、资产、npm 和市场并做隔离新装及旧版升级验收。

发布记录：[0.3.0](2026-11-12-0.3.0.md)、[独立仓库迁移](2026-11-11-migration.md)。历史验证保留在 evals/runs/；其中旧仓库路径和链接描述记录时的现场。
