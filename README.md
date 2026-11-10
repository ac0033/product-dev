# Agent Skills

自研与收录的 Agent 技能集合，覆盖从需求、原型、架构到开发、测试、发布的全过程。每个技能以 `SKILL.md` 为入口。

## 怎么用

交互入口只有一个：[project-flow](project-flow/SKILL.md)。直接向 agent 说想法或要求（“我想做一个……”“给它加个导出”“这里报错了”“把这段文案改一下”），它先判断属于新项目、加功能、修 bug、小改动、只改文档还是装或升级套件，用一句话说明判断结果，然后按对应路线推进。不需要记其他技能的名字：设计技能组和 engineering-kit 都不出现在命令菜单，由入口按需加载。

## 技能目录

| 入口 | 适用任务 | 配套内容 |
|---|---|---|
| [project-flow](project-flow/SKILL.md) | 唯一入口：判断情况并分流，带着走完设计、开发、复审、合并、验收与发布 | 流程细则、任务拆解、调试、独立复审四份参考 |
| [产品设计技能组](product-design-orchestrator/README.md) | 从想法推进到 PRD、交互原型、系统架构和实施交接 | 由入口加载；总控与三个专业技能，共享协议和产物模板 |
| [engineering-kit](engineering-kit/SKILL.md) | 装进项目的强制层：规则块、闸门、钩子、模板；安装、升级、回滚与发布 | 同步工具、工程模板、经验记录和测试 |
| [evals](evals/cases.md) | 技能包自身的验证 | 一致性检查（`node --test evals/consistency.test.mjs`）、冲突矩阵、行为用例 |
| [语言风格 System Prompt](语言风格%20System%20Prompt.md) | 独立的中文表达约定 | 单文件 |

## 获取与使用

```bash
git clone https://github.com/ac0033/skills.git
cd skills
```

把 `project-flow/`、四个设计技能目录、`engineering-kit/` 和 `evals/` 放进宿主的技能目录并保持同级（技能之间用相对路径互相引用）。宿主不支持自动加载技能时，让 Agent 打开 `project-flow/SKILL.md`，并提供任务与材料。

## 来源与许可

各子目录保留各自的来源与许可文件，见对应 README、SKILL 和 LICENSE；本仓库不为所有收录内容统一声明新的许可。

### 外部工具

本仓库的技能会按名称调用或推荐下列外部工具。它们不随本仓库分发，需要各自安装，使用时遵守各自的许可。都是可选的：没装或宿主不支持时改用最后一栏的做法，该步骤的过关证据不变。

| 工具 | 在这里的用途 | 与本仓库的关系 | 许可 | 没装时的替代 |
|---|---|---|---|---|
| [feature-dev](https://github.com/anthropics/claude-plugins-official)（Anthropic 官方插件）的三个子代理 `feature-dev:code-explorer`、`feature-dev:code-architect`、`feature-dev:code-reviewer` | 代码探索、方案对比、独立复审 | 只按名称调用子代理；不调用它的 `/feature-dev` 命令 | 所在仓库为 Apache-2.0 | 通用子代理，复审时带 project-flow 的复审任务书 |
| [ponytail](https://github.com/DietrichGebert/ponytail)（含 ponytail-review、ponytail-audit、ponytail-debt） | 约束改动量、作者自查、全仓巡检 | 只按名称推荐 | MIT | 流程细则里的自查清单和任务拆解里的每片自问；巡检只跑套件的机械检查 |
| [archify](https://github.com/tt-a1i/archify) | 架构图与流程图 | 只按名称推荐 | Apache-2.0 | Mermaid |
| impeccable | 界面设计与界面复查 | 只按名称推荐 | 以其发布页为准 | 沿用项目已有的设计资产 |
| Claude Code 内置的 `/code-review`、`/security-review`、`/simplify` | 独立复审、安全专项、测试转绿后的清理 | 只按名称调用 | 随 Claude Code | 其他宿主用通用子代理做复审和安全专项；清理改为手工 |
| [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | 任务拆解、增量实现、调试、代码评审方法的来源 | 改写为 project-flow 的三份参考，文末注明出处 | MIT | 不需要安装 |

改写或摘录第三方内容的文件都在文末注明出处，版权声明和许可全文见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。除该文件列出的以外，本仓库没有收录上述项目的代码或原文。
