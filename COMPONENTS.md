# 组件清单

Product Dev 由一个综合插件和多个组件构成。综合插件（[plugin/](plugin/skills/product-dev/SKILL.md)，0.3.1：入口技能含全部路线，每一步写明目标、原则、工具和过关证据）是各组件内容按流程重组后的结合，也是唯一接入 agent 的部分；组件各自完整、可单独使用：它们是综合插件的构建源（改动先改组件，再重新构建插件），本仓库不单独发布组件，要单独使用的由使用者自己把组件目录安装到 agent。

## 自有组件

存放在 [components/](components/)，以 [MIT](LICENSE) 发布。

| 组件 | 位置 | 用途 | 在综合插件里对应的部件 |
|---|---|---|---|
| engineering-kit | [components/engineering-kit/](components/engineering-kit/SKILL.md) | 工程规则、闸门、钩子、模板的安装与升级，开发流程 | 整目录收录为内部技能 `skills/engineering-kit/` |
| 产品设计技能组 | [components/product-design-orchestrator/](components/product-design-orchestrator/README.md) 及三个同级子技能目录 | 需求、原型、架构、实施交接 | 四个目录各自整目录收录为内部技能 |

## 第三方组件

原版不在本仓库存档，要单独使用或重新构建，请按下表的来源和提交到来源仓库获取。综合插件里收录了实际用到的部分，随插件分发；出处、改动、版权声明与许可全文见插件的[第三方声明](plugin/THIRD_PARTY_NOTICES.md)。

| 组件 | 来源 | 取用的版本 | 许可 | 在综合插件里对应的部件 |
|---|---|---|---|---|
| impeccable | <https://github.com/pbakaus/impeccable> | 4.8.2（`skill-v4.8.2` 之后的 main 提交 ec229b4，2026-11-10；固定引擎 0.1.22） | Apache-2.0 | 已收录：内部技能 `skills/impeccable/` 和四个 `impeccable-*` 子代理 |
| archify | <https://github.com/tt-a1i/archify> | 3.2.0（提交 7e45f36，2026-11-10） | Apache-2.0 | 已收录：内部技能 `skills/archify/`（不含示例成品页） |
| feature-dev | <https://github.com/anthropics/claude-plugins-official>（`plugins/feature-dev`） | 1.0.1 | Apache-2.0 | 已收录：`code-explorer`、`code-architect`、`code-reviewer` 三个子代理 |
| ponytail | <https://github.com/DietrichGebert/ponytail> | 5.3.3（提交 96608e0，2026-10-29） | MIT | 已收录（翻译和改写）：入口技能的方法文档 `build.md`（最小改动规则）、`self-review.md`（推送前自查清单） |
| agent-skills | <https://github.com/addyosmani/agent-skills> | 0.6.15（提交 301b02b，2026-11-01） | MIT | 已收录（翻译和改写）：入口技能的方法文档 `planning.md`、`debugging.md`、`review.md`，以及 `build.md` 的逐片循环 |

## 综合插件怎样生成

插件分两部分。手写的部分：入口技能目录 `plugin/skills/product-dev/`（入口和它的方法文档）、两份插件清单、第三方声明；构建脚本不生成、不覆盖、不删除它们。取自组件的部分不手改，由 `node tools/build-plugin.mjs`（在仓库根目录运行）从组件复制生成，各部分的来源、版本、文件数和内容哈希记录在 [BUILD.lock.json](plugin/BUILD.lock.json)。重新构建第三方原文部分时，在 `vendor/`（该目录被 git 忽略）下准备三个目录：`impeccable/` 和 `archify/` 是来源仓库按上表提交的完整 git 检出，impeccable 还要带上游标签（构建从 `engine-v<固定版本>` 标签读引擎支持的命令，核对技能文本引用的命令，命令表写进锁文件）；`feature-dev/` 是来源仓库 `plugins/feature-dev` 子目录的普通副本（不是 git 检出），文本文件保持 LF 换行。没有这些目录时，脚本只重建自有组件部分，第三方部分保持仓库里已提交的内容。构建结果由 `node --test evals/plugin-build.test.mjs` 核对，入口每一步的工具是否真实存在由 `node --test evals/entry.test.mjs` 核对。

插件成品之外还有两种分发形态，都由插件成品装配，不另存内容：给其他 Agent 的技能包（`tools/build-portable-skill.mjs`），以及给 DeepSeek Harness 的 npm 包（[dsh/](dsh/README.md) 里是手写的包清单和注册入口，`tools/build-dsh-package.mjs` 把技能包装进去）。
