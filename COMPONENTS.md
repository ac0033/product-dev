# 组件清单

本仓库由一个综合插件和多个组件构成。综合插件（[product-dev/](product-dev/skills/product-dev/SKILL.md)，0.1.0 骨架版：已装配各部件，入口技能只做分流，完整流程待补）是各组件内容按流程重组后的结合，也是唯一接入 agent 的部分；组件各自完整、可单独使用，只存档，需要时由使用者自己安装到 agent。

## 自有组件

存放在本仓库，以 [MIT](LICENSE) 发布。

| 组件 | 位置 | 用途 | 在综合插件里对应的部件 |
|---|---|---|---|
| engineering-kit | [engineering-kit/](engineering-kit/SKILL.md) | 工程规则、闸门、钩子、模板的安装与升级，开发流程 | 整目录收录为内部技能 `skills/engineering-kit/` |
| 产品设计技能组 | [product-design-orchestrator/](product-design-orchestrator/README.md) 及三个同级子技能目录 | 需求、原型、架构、实施交接 | 四个目录各自整目录收录为内部技能 |

## 第三方组件

原版只存放在维护者本机的 `vendor/` 目录（被 git 忽略），不随本仓库分发。要单独使用，请到来源仓库获取。下表记录存档的版本，以及综合插件取用了哪些内容。已取用的部分随插件分发，出处、改动、版权声明与许可全文见插件的[第三方声明](product-dev/THIRD_PARTY_NOTICES.md)；尚未取用的标为“计划”。

| 组件 | 来源 | 存档版本 | 许可 | 在综合插件里对应的部件 |
|---|---|---|---|---|
| impeccable | <https://github.com/pbakaus/impeccable> | 4.8.2（提交 ec229b4，2026-11-10） | Apache-2.0 | 已收录：内部技能 `skills/impeccable/` 和四个 `impeccable-*` 子代理 |
| archify | <https://github.com/tt-a1i/archify> | 3.2.0（提交 7e45f36，2026-11-10） | Apache-2.0 | 已收录：内部技能 `skills/archify/`（不含示例成品页） |
| feature-dev | <https://github.com/anthropics/claude-plugins-official>（`plugins/feature-dev`） | 1.0.1 | Apache-2.0 | 已收录：`code-explorer`、`code-architect`、`code-reviewer` 三个子代理 |
| ponytail | <https://github.com/DietrichGebert/ponytail> | 5.3.3（提交 96608e0，2026-10-29） | MIT | 计划：最小改动规则、自查清单（改写后收录，尚未收录） |
| agent-skills | <https://github.com/addyosmani/agent-skills> | 0.6.15（提交 301b02b，2026-11-01） | MIT | 计划：任务拆解、调试、评审方法（改写后收录，尚未收录） |

## 综合插件怎样生成

插件里取自组件的部分不手改，由 `node tools/build-plugin.mjs` 从组件复制生成，各部分的来源、版本、文件数和内容哈希记录在 [BUILD.lock.json](product-dev/BUILD.lock.json)。本机没有 `vendor/` 时，脚本只重建自有组件部分，第三方部分保持仓库里已提交的内容。构建结果由 `node --test evals/plugin-build.test.mjs` 核对。
