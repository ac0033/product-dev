# 发布维护

1. 从 main 开分支，更新两份插件清单、dsh/package.json 和安装文档中的版本。
2. 运行 node tools/build-plugin.mjs 和 node --test evals/*.test.mjs，提交并通过 PR 的跨平台 CI 与双审后合并。
3. 在同一个合并提交创建两个带说明的标签：插件的 `v<插件版本>` 和工程套件的 `engineering-kit-v<套件版本>`（套件回滚与升级按 `--from-tag engineering-kit-v…` 定位版本，缺了就找不到）。
4. 先清空 dist/：打包脚本要求输出目录不存在，留着上次的 dist/ 会直接报错，也会把旧产物混进核对；dist/ 被 git 忽略，删除前看一眼里面没有要保留的文件（PowerShell：Remove-Item -Recurse -Force dist；bash：rm -rf dist）。然后运行 node tools/package-release.mjs dist，按 dist/SHA256SUMS.txt 核对产物。
5. 发布 dist/dsh-product-dev-<版本>.tgz 到 npm；GitHub Release 附 product-dev-plugin.zip、product-dev-skill.zip、npm tarball 和 SHA256SUMS.txt。
6. 在 ac0033/skills 的两份市场清单同步版本和 git-subdir ref，回读公开标签、资产、npm 和市场并做隔离新装及旧版升级验收。

## 执行位置

发布前的构建、测试和 PR 合并按工程套件的通用环节办（见 [process.md](../../components/engineering-kit/references/process.md) 的“每个环节的工作在哪做”），下面两个环节是本仓库发布特有的。决定顺序与通用环节相同：用户的选择 > 两条原则（更快、更便宜、更高效、更准确，结合本机实际情况）自动判断 > 多种做法可行且原则指向不同时问用户。

| 环节 | 工作 | 在哪做 | 谁定 |
|---|---|---|---|
| D 发布（第 2 步，合并前） | 运行 `build-plugin.mjs` 和 `evals`（生成与相关测试） | 当前会话本机跑（AGENTS.md：本机只跑与改动相关的测试，生成物要提交） | 项目规则（AGENTS.md） |
| D 发布（第 2 步，合并前） | 跨平台全量测试 | PR 的 CI（Linux、Windows） | 项目规则（AGENTS.md） |
| D 发布（第 2 步，合并前） | 独立代码复审与增量一致性审 | Linux、Windows CI 都成功后才做（本仓库 AGENTS.md 的规则，比套件通用规则的“可与 CI 并行”更严），执行位置按 B 环节：宿主子代理、或配了外部执行器（如 Codex）的那台机器 | 项目规则（AGENTS.md） |
| D 发布（第 3 步） | 在合并提交上创建插件和套件两个标签 | 当前会话，需要用户授权 | 用户授权 |
| D 发布（第 4 步） | 在标签对应的提交上打包并核对 SHA256SUMS | 标签推送后 `release-artifacts` 工作流在 CI（Linux）上跑 `evals`、打包，并把 zip、tgz 和 `SHA256SUMS.txt` 作为产物上传；当前会话本机再按第 4 步运行 `package-release.mjs` 并核对哈希，发布用的是核对过的那一份 | 当前做法固定；改做法另开 PR |
| D 发布（第 5–6 步的对外部分） | 发布 npm、创建 GitHub Release、同步 ac0033/skills 市场清单 | 当前会话，需要用户授权；每一步都是对外动作，不并行抢跑 | 用户授权 |
| E 发布后验收（第 6 步的回读与验收） | 回读公开标签、资产、npm 和市场；隔离新装与旧版升级验收 | 隔离新装要在干净环境里做：优先云端会话或 CI，不污染本机；回读公开页面在当前会话即可 | 按两条原则；多种可行且代价不同时问用户 |

发布步骤不省、不降：执行位置只决定在哪做，不改变上面 1–6 步的顺序和核对标准。

发布记录：[0.5.0](2026-11-26-0.5.0.md)、[0.4.0](2026-11-25-0.4.0.md)、[0.3.2](2026-11-13-0.3.2.md)、[0.3.1](2026-11-13-0.3.1.md)、[0.3.0](2026-11-12-0.3.0.md)、[独立仓库迁移](2026-11-11-migration.md)。历史验证保留在 evals/runs/；其中旧仓库路径和链接描述记录时的现场。
