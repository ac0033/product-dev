# 组件清单

本仓库由一个综合插件和多个组件构成。综合插件（`product-dev`，建设中）是各组件内容按流程重组后的结合，也是唯一接入 agent 的部分；组件各自完整、可单独使用，只存档，需要时由使用者自己安装到 agent。

## 自有组件

存放在本仓库，以 [MIT](LICENSE) 发布。

| 组件 | 位置 | 用途 | 在综合插件里对应的部件 |
|---|---|---|---|
| engineering-kit | [engineering-kit/](engineering-kit/SKILL.md) | 工程规则、闸门、钩子、模板的安装与升级，开发流程 | 工程套件脚本、规则 R1–R10、流程细则 |
| 产品设计技能组 | [product-design-orchestrator/](product-design-orchestrator/README.md) 及三个同级子技能目录 | 需求、原型、架构、实施交接 | 需求、原型、架构三个角色，设计协议与模板 |

## 第三方组件

原版只存放在维护者本机的 `vendor/` 目录（被 git 忽略），不随本仓库分发。要单独使用，请到来源仓库获取。下表记录存档的版本，以及综合插件会取用哪些内容；取用的部分随插件发布时，会在插件的第三方声明里注明出处、改动，并附版权声明与许可全文。

| 组件 | 来源 | 存档版本 | 许可 | 在综合插件里对应的部件 |
|---|---|---|---|---|
| impeccable | <https://github.com/pbakaus/impeccable> | 4.8.2（提交 ec229b4，2026-11-10） | Apache-2.0 | 界面设计 |
| archify | <https://github.com/tt-a1i/archify> | 3.2.0（提交 7e45f36，2026-11-10） | Apache-2.0 | 图表 |
| feature-dev | <https://github.com/anthropics/claude-plugins-official>（`plugins/feature-dev`） | 1.0.1 | Apache-2.0 | 代码探索、方案设计、代码复审三个子代理 |
| ponytail | <https://github.com/DietrichGebert/ponytail> | 5.3.3（提交 96608e0，2026-10-29） | MIT | 最小改动规则、自查清单 |
| agent-skills | <https://github.com/addyosmani/agent-skills> | 0.6.15（提交 301b02b，2026-11-01） | MIT | 任务拆解、调试、评审方法 |
