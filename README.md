# Agent Skills

自研与收录的 Agent 技能集合，覆盖工程流程、产品需求、交互原型和系统架构。每个技能以 `SKILL.md` 为入口。

## 技能目录

| 入口 | 适用任务 | 配套内容 |
|---|---|---|
| [产品设计技能组](product-design-orchestrator/README.md) | 从想法推进到 PRD、交互原型、系统架构和实施交接 | 总控（唯一入口）与三个专业技能，共享协议和产物模板 |
| [engineering-kit](engineering-kit/SKILL.md) | 工程规则与闸门、开发流程和经验整理 | 同步工具、工程模板、流程规范和测试 |
| [evals](evals/cases.md) | 技能包自身的验证 | 一致性检查（`node --test evals/consistency.test.mjs`）、冲突矩阵、行为用例 |
| [语言风格 System Prompt](语言风格%20System%20Prompt.md) | 独立的中文表达约定 | 单文件 |

## 获取与使用

```bash
git clone https://github.com/ac0033/skills.git
cd skills
```

让支持读取文件的 Agent 打开所选技能的 `SKILL.md`，并提供任务与材料。

## 来源与许可

各子目录保留各自的来源与许可文件，见对应 README、SKILL 和 LICENSE；本仓库不为所有收录内容统一声明新的许可。

### 外部工具

本仓库的技能会按名称调用或推荐下列外部工具。它们不随本仓库分发，需要各自安装，使用时遵守各自的许可；没装时按技能里写的替代做法执行。

| 工具 | 在这里的用途 | 与本仓库的关系 | 许可 |
|---|---|---|---|
| [feature-dev](https://github.com/anthropics/claude-plugins-official)（Anthropic 官方插件） | 代码探索、方案对比、独立复审的子代理 | 只按名称调用 | 所在仓库为 Apache-2.0 |
| [ponytail](https://github.com/DietrichGebert/ponytail) | 约束改动量、作者自查、全仓巡检 | 只按名称推荐 | MIT |
| [archify](https://github.com/tt-a1i/archify) | 架构图与流程图 | 只按名称推荐 | Apache-2.0 |
| impeccable | 界面设计与界面复查 | 只按名称推荐 | 以其发布页为准 |
| [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | 任务拆解、调试、代码评审等方法的参考来源 | 目前只在冲突矩阵里提及，未收录其文本 | MIT |

截至当前版本，本仓库没有收录上述项目的代码或原文。以后凡是改写或摘录第三方内容的文件，都在该文件末尾注明出处，并在仓库根目录的 `THIRD_PARTY_NOTICES.md` 里附上对应的版权声明和许可全文。
