---
name: product-dev
description: 产品开发的唯一入口。用户提出产品或开发相关的想法时使用：做一个新产品或新项目、给现有项目加功能、修 bug、做小改动、只改文档、给项目装或升级工程套件。先判断属于哪种情况，再交给插件自带的技能和子代理执行。
---

# product-dev：产品开发入口

> 当前是骨架版（0.1.0）：只做分流和交接。每条路线的完整步骤（每步的目标、原则、工具、过关证据）在后续版本补全；在此之前，各步骤按被交接技能自己的说明执行。

用户只需要说想法。先看清现场，再从下表选一种情况；拿不准时向用户问一次，不要自行猜测后开工。

## 1. 看清现场

确认目标项目目录、是否已是 git 仓库、是否已装工程套件（有没有 `engineering.config.json`）、项目规则文件和 `PROJECT_STATE.md` 里记录的当前阶段。续做时以实际的提交、开着的 PR 和运行记录为准。

## 2. 分流

| 情况 | 怎样判断 | 交给谁 |
|---|---|---|
| 新项目 | 目录是空的，或还没有可运行的产品 | 先用[工程套件](../engineering-kit/SKILL.md)装好工程底座，再由[设计总控](../product-design-orchestrator/SKILL.md)走需求、原型、架构，交接后按[开发流程](../engineering-kit/references/process.md)实现 |
| 加功能 | 已有项目，要新增或改变一项能力 | 需求、界面或架构有变的，由[设计总控](../product-design-orchestrator/SKILL.md)只启动对应角色；然后用子代理 code-explorer 摸清现有实现、code-architect 比较方案，按[开发流程](../engineering-kit/references/process.md)实现，code-reviewer 独立复审 |
| 修 bug | 现有行为与预期不符 | 子代理 code-explorer 定位原因；按[开发流程](../engineering-kit/references/process.md)先复现再修，code-reviewer 独立复审 |
| 小改动 | 范围清楚、不改变对外行为的少量修改 | 直接按[开发流程](../engineering-kit/references/process.md)改，不启动设计角色 |
| 只改文档 | 不涉及代码和配置 | 直接按[开发流程](../engineering-kit/references/process.md)里对文档的要求改，不启动设计角色和子代理 |
| 装或升级工程套件 | 用户要安装、升级、检查或回滚工程规则与闸门 | [工程套件](../engineering-kit/SKILL.md)的安装与升级命令 |

一个想法同时属于几种情况时，拆开后分别走；用户没有授权实现时，设计交接后就停。

## 3. 各环节用到的部件

| 环节 | 部件 | 位置 |
|---|---|---|
| 需求、原型、架构 | 设计总控和三个设计角色 | [product-design-orchestrator](../product-design-orchestrator/SKILL.md)、[product-discovery-prd](../product-discovery-prd/SKILL.md)、[prototype-design](../prototype-design/SKILL.md)、[system-architecture-design](../system-architecture-design/SKILL.md) |
| 界面设计与界面走查 | impeccable | [impeccable](../impeccable/SKILL.md) |
| 架构图、流程图 | archify | [archify](../archify/SKILL.md) |
| 工程底座、闸门、开发流程 | 工程套件 | [engineering-kit](../engineering-kit/SKILL.md) |
| 代码探索、方案对比、独立复审 | 子代理 | [code-explorer](../../agents/code-explorer.md)、[code-architect](../../agents/code-architect.md)、[code-reviewer](../../agents/code-reviewer.md) |

贯穿全程的规则只有一个出处：[工程流程规则块](../engineering-kit/kit/rules/AGENTS.block.md)的 R1–R10。本文件与它不一致时，以规则块为准。

宿主不支持插件自带的子代理时，把上表里子代理文件的内容作为任务书交给宿主的通用子代理。
