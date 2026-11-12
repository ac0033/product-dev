# Product Dev

**面向 Claude Code、Codex、DeepSeek Harness 及其他支持 Agent Skills 的 Agent 的产品开发插件（0.3.1）。** 把一个产品想法或现有项目的改进目标，逐步变成可核对的设计、代码和交付结果。既能从零做产品、加功能、修 bug，也能只做设计、文档修改、复审、验收或工程套件维护。

内置三组协作能力：**产品设计**（需求梳理、PRD、原型与界面设计、架构与图表）、**工程实现**（代码探索、方案对比、任务拆解、开发测试与调试）、**质量与交付**（检查闸门、独立审查、PR 与合并、验收与获授权的发布）。一个入口按任务选择需要的阶段，沿用项目规则，保留阶段产物与验证证据，帮助你减少遗漏、反复解释和交接断层。各阶段执行依赖[宿主提供的工具](INSTALL.md)。

[快速开始](#快速开始) · [怎么用](#怎么用) · [流程图](#流程图) · [参考与许可](#参考与许可)

## Product Dev 怎么推进一次任务

你从**同一个入口**描述目标、现状和想先做到哪一步。Product Dev 判断需要哪些阶段，沿用项目已有的规则和检查，并把前一阶段确认的结果带进下一阶段。

1. **判断路线。** 先读项目规则、工作区和已有记录。新项目从需求开始，加功能先梳理现有行为，修 bug 先复现。低风险的小新增、小改动、纯文档和套件维护有各自的短路线。
2. **推进当前阶段。** 例如做新产品时，先确认需求，再做原型走查和架构设计。功能改动进入开发前，先写清验收标准。你也可以只做设计、复审或验收中的一段。
3. **交付可核对的结果。** 每阶段有产物和通过条件，交接时说明已完成、已验证和待确认的事项。接着做以前的任务时，可以直接提供相关分支、PR 或设计文档。

## 快速开始

**让 Agent 替你装。** 把下面这段话原样发给你正在用的 Agent。读到本仓库的 Agent 也可以直接照做。

```text
安装 Product Dev 插件，只用下面写明的命令和来源。先用你所在宿主的 list 命令查一下：已经装了 product-dev@ac0033-skills 就不要重复安装，只告诉我版本号；装了但没启用的也不重装，Claude Code 运行 `claude plugin enable product-dev@ac0033-skills`，其他宿主告诉我去插件设置里启用。Claude Code：运行 `claude plugin marketplace add ac0033/skills`，再运行 `claude plugin install product-dev@ac0033-skills`，然后用 `claude plugin list` 确认 product-dev@ac0033-skills 的 Status 是 enabled。Codex：运行 `codex plugin marketplace add ac0033/skills`，再运行 `codex plugin add product-dev@ac0033-skills`，然后用 `codex plugin list` 确认它的状态是 `installed, enabled`（`not installed` 不算）。DeepSeek Harness、OpenCode 等其他 Agent：读取 https://raw.githubusercontent.com/ac0033/product-dev/main/INSTALL.md，按其中“给 Agent 的安装步骤”一节安装。add 或 install 提示已存在时，以 list 的结果为准，不算失败。其余命令失败时把命令和输出原样告诉我。装完告诉我版本号，并提醒我新开会话后用 product-dev 入口开始。
```

每一步的验证办法和注意事项见[给 Agent 的安装步骤](INSTALL.md#agent-install)。想自己动手，按下面对应的宿主安装。

### Claude Code

在终端安装。

```bash
claude plugin install product-dev --marketplace ac0033/skills
```

较早的版本可以在终端分两步安装。

```bash
claude plugin marketplace add ac0033/skills
claude plugin install product-dev@ac0033-skills
```

打开 Claude Code，在输入框用 `/product-dev:product-dev` 加上你的任务。若在现有会话安装后尚未看到入口，可运行 `/reload-plugins` 或重新启动 Claude Code。

### Codex

在终端运行下面的命令。需要支持 `codex plugin` 子命令的 Codex CLI。

```bash
codex plugin marketplace add ac0033/skills
codex plugin add product-dev@ac0033-skills
```

在 Codex 桌面端的输入框技能列表选择插件下的 `product-dev`。CLI 中可用 `/skills` 选择 `product-dev:product-dev`。桌面端若仍显示旧列表，可重启后再试。

### DeepSeek Harness

在网页版或桌面版打开 **Plugins → Add plugin**，输入下面的包名和版本号，安装后启用。

```text
dsh-product-dev@0.3.1
```

在输入框用 `/product-dev` 加上你的任务。命令行安装和不装插件的用法见[其他 Agent 安装指南](INSTALL.md#deepseek-harness)。

### 其他 Agent

安装一个自包含的 `product-dev` 技能包即可。按[其他 Agent 安装指南](INSTALL.md)导入或配置，保留包内资料和脚本。

### 试一句

> 我想做一个给读书会用的活动报名工具。先梳理参与者和组织者的需求，给出第一版范围和验收标准。等我确认需求后再做原型。

<a id="upgrade"></a>

<details>
<summary><strong>升级已有的 GitHub 市场安装</strong></summary>

市场名和插件名保持不变。已有市场安装无需卸载，运行下面的更新命令即可切换到独立仓库的版本。

Claude Code 在终端运行下面的命令，然后重新启动。

```bash
claude plugin marketplace update ac0033-skills
claude plugin update product-dev@ac0033-skills
```

Codex 在终端运行下面的命令，然后重新启动桌面端。

```bash
codex plugin marketplace upgrade ac0033-skills
codex plugin add product-dev@ac0033-skills
```

</details>

## 怎么用

在目标项目目录开始对话。把**目标、已知约束、你希望停下确认的阶段**交给 Product Dev。比如把「加个候补」说成「给活动报名加候补，按报名时间递补。先写清规则和验收标准，等我确认后再实现」。

| 你要做什么 | Product Dev 先做什么 | 你能用什么验收 |
| --- | --- | --- |
| 从零做一个读书会报名工具 | 建立工程底座，梳理用户、问题与范围 | 需求文档、可操作原型、架构和实施交接 |
| 给现有报名页加候补 | 核对报名流程，找出受影响的行为 | 功能契约、边界用例、方案与验证证据 |
| 修复取消报名仍占用名额 | 复现问题、定位根因并写失败测试 | 修复与回归测试，可对照修前和修后的结果 |
| 改按钮文案或补安装说明 | 判断影响范围，走小改动或纯文档路线 | 对应改动和检查结果 |
| 检查工程套件版本 | 对照安装状态和项目差异 | 漂移清单与可审的升级范围 |

询问可行性时，Product Dev 先做只读分析。明确要求实施时，它在授权和项目规则内推进。新项目的工程底座安装会先说明目标目录。生产发布、回滚和破坏性迁移需要对应授权。

**工程套件需要单独安装吗？** Product Dev 已带 `engineering-kit`，可以直接读取规则和调用随附脚本。新项目在获准开工后，把规则、模板和闸门同步进项目。已有项目沿用自己的检查机制，需要引入或升级套件时再按授权同步。

## 流程图

新项目和加功能各有准备阶段，后续共用同一条交付路线。修 bug 从复现和根因入手，再接到交付后半段。点击任一图可以放大查看。

### 新项目 · 从想法到实施就绪

先确认需求，再用原型走查验证体验。综合评审通过后配置检查命令，获准实施才进入交付段。

<a href="docs/images/new-project.png"><img src="docs/images/new-project.png" width="507" alt="新项目原流程图。恢复现场后安装工程底座，依次推进需求、原型与走查、架构、综合评审和闸门配置。发现需求缺口时返回需求阶段。"></a>

### 加功能 · 从现状到选定方案

先探索现有代码和行为。改变产品行为时回到设计阶段修订受影响的部分，再确认验收标准与实施方案。低风险的小新增不走这一节，不做契约和方案对比，见入口的缩短路线。

<a href="docs/images/feature.png"><img src="docs/images/feature.png" width="750" alt="加功能流程图。开工检查、探索和澄清后判断是否改变产品行为。需要时回设计段修订，再经过功能契约，方案对比按最小改动、结构清晰、折中三种做法各派一次，由用户选定方案。小新增不走这一节，按第 6 节的简化路线。"></a>

### 共用交付 · 从任务拆解到发布

图中采用 PR 复审顺序。若项目配置为推送前复审，独立复审在机械闸门通过后、推送前执行。测试设计在逐片开发之前，由不写实现的子代理按场景表先写测试。生产发布按任务范围和授权执行。

<a href="docs/images/delivery.png"><img src="docs/images/delivery.png" width="750" alt="共用交付流程图。任务拆解后先做测试设计，再逐片开发、推送前自查。机械闸门首次候选跑全量，修复后只跑受影响部分；再经 PR 与 CI、独立复审、合并与收工，以及获准的验收与发布。独立复审首轮查全，要修时回到逐片开发，收齐再改，修后只复核增量。"></a>

### 修 bug · 从复现到回归入库

先判断是实现故障还是需求缺口。确认属于实现故障后，用失败测试固定复现条件，修复并通过相应检查。

<a href="docs/images/bug-fix.png"><img src="docs/images/bug-fix.png" width="727" alt="修 bug 原流程图。稳定复现并定位根因。需求缺口转加功能路线，实现故障写失败测试，做最小修复，核对同类问题和调用方，再复审合并并保留回归用例。"></a>

## 参考与许可

- **完整流程**见[入口技能](plugin/skills/product-dev/SKILL.md)和[工程流程说明](plugin/skills/product-dev/references/process.md)，各阶段的工具、验收证据和复审顺序都在这里。
- **组件与版本**见[组件清单](COMPONENTS.md)。可用工具随宿主而异，流程文档说明了按路径读取内部技能和派发子代理的替代方式。
- **测试与许可**见[测试与行为用例](evals/cases.md)、[MIT](LICENSE)和[第三方声明](plugin/THIRD_PARTY_NOTICES.md)。
