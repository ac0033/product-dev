# Product Dev 维护规则

Product Dev 是独立项目。保持市场名 ac0033-skills、插件名 product-dev 和 npm 包名 dsh-product-dev；市场导航在 [ac0033/skills](https://github.com/ac0033/skills) 维护。

## 目录与修改

- plugin/ 是分发成品；入口技能及方法文档、两份插件清单和第三方声明为手写内容。其他成品由 tools/build-plugin.mjs 从 components/ 生成，不直接改副本。
- components/ 保持内部组件关系；dsh/ 是 npm 包源；tools/ 是构建与发布脚本；evals/ 是测试和行为记录；docs/ 是图及发布记录。组件清单见 COMPONENTS.md。
- 修改前检查工作区与工作树，从最新 main 开分支，保护其他会话。禁止将本机私有材料或 vendor/ 上游检出提交到公开仓库。

## 验证、审查与合并

运行 node --test evals/*.test.mjs。改工程套件时同时运行其自身测试。PR 的 Linux、Windows CI 成功后做独立代码复审与增量一致性审，将两份结论和最终 SHA 登记在 PR；高、中级问题修复后才能合并。合并入口为 GitHub PR merge API 或 gh pr merge，核对 expected head SHA，不绕过失败的检查。

## 发布

两份插件清单、dsh/package.json 和使用文档的版本保持一致；源码元数据指向本仓库。发布流程见 docs/release/README.md；发布需要对应用户授权。旧 skills 标签和资产保留。迁移记录见 docs/release/2026-11-11-migration.md。
