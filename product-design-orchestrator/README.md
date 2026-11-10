# Product Design Skills

用于 AI 辅助产品设计的一组技能，覆盖需求探索、原型验证、系统架构和实施交接。AI 负责专业分析与验证，用户参与产品目标、核心体验、隐私和费用等重要决策。

## 技能与流程

| 技能 | 用途 |
|---|---|
| [product-design-orchestrator](SKILL.md) | 协调三个独立专业上下文，管理阶段、变更和跨文档一致性 |
| [product-discovery-prd](../product-discovery-prd/SKILL.md) | 探索问题和用户场景，形成范围明确、可验证的 PRD |
| [prototype-design](../prototype-design/SKILL.md) | 设计信息架构、用户流程与可操作原型，验证核心体验 |
| [system-architecture-design](../system-architecture-design/SKILL.md) | 设计系统边界与运行机制，产出架构图、决策记录和实施交接 |

默认流程：**PRD → 原型验证 → 架构设计 → 综合评审与实施交接**。

各阶段可以双向反馈。原型暴露需求缺口、架构发现体验或成本冲突时，由主对话协调相关角色修订，并复核受影响的下游产物。已有设计项目从当前有效版本续接。用户的交互入口是 [project-flow](../project-flow/SKILL.md)：它判断出属于新项目或需要修订设计时加载总控，单阶段任务由总控只启动对应角色。总控和三个子技能都不出现在命令菜单。

## 安装与调用

将四个技能目录和 `project-flow/`、`engineering-kit/`、`evals/` 一起放入宿主支持的技能目录，并保持同级位置。技能之间通过相对路径互相引用，不能只复制其中一个。新项目第一步由 project-flow 安装 engineering-kit，设计文档放它建好的阶段目录。

```text
skills/
├── project-flow/
├── product-design-orchestrator/
│   ├── SKILL.md
│   └── references/
│       ├── shared-protocol.md
│       └── artifacts.md
├── product-discovery-prd/SKILL.md
├── prototype-design/SKILL.md
├── system-architecture-design/SKILL.md
├── engineering-kit/
└── evals/cases.md
```

直接向 agent 说出想法或设计任务即可，project-flow 会按情况加载总控；在支持技能名称调用的宿主中也可以写明：

```text
使用 $project-flow，在指定项目目录推进产品设计。
先核对已有资料和进度，再从缺少的阶段开始。
```

宿主不能自动加载技能时，提供 `project-flow/SKILL.md` 的绝对路径，要求 agent 读取执行。调用时明确目标项目目录和本次范围。

## 运行条件与产物

需要 agent 能够读取技能文件、读写目标项目工作区。可操作原型需要相应运行与检查工具；自动调度专业上下文需要宿主支持子代理或聊天协调。工具不足时使用技能提供的手动交接方式，并明确未执行的步骤。

项目产物按需生成，位置见共享协议第 2 节，默认包括：

- `PROJECT_STATE.md` 与 `RECORDS.md`：进度索引、决定、变更和交接。
- `PRD.md`：产品目标、需求、规则和验收标准。
- `PROTOTYPE.md` 与原型文件：信息结构、用户路径、交互和走查结果。
- `ARCHITECTURE.md` 与必要的 ADR：上下文图、高层架构图、关键机制和设计依据。
- `IMPLEMENTATION.md`：实施准备度、实施顺序及需求到验证证据的追踪；任务切片由开发阶段写在 `docs/04-开发/` 的计划里，归实施方维护。

目录、版本、归属及协作规则见[共享协议](references/shared-protocol.md)，字段要求见[产物模板](references/artifacts.md)。沿用项目已有的等价文档，避免重复维护。

## 验证与边界

技能修改后检查格式、相对引用及[行为验收用例](../evals/cases.md)。实际项目验收还需核对用户确认、原型操作、技术实验和实施准备度。

设计确认、代码实现、真实验证和发布是不同状态。设计技能组的终点是实施交接，之后由 project-flow 的交付段接手；生产实现与发布由用户任务范围决定；模拟原型和文档检查不能替代真实功能验收。使用技能不会扩大宿主权限或自动授权付费、外发及发布操作。

## 版本记录

### 0.1.0 · 2026-11-02

首次发布总控、需求探索、原型设计与系统架构四个技能，提供共享协作协议、产物模板和行为验收用例。
