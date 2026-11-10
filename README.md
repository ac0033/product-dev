# Agent Skills

自研与收录的 Agent 技能集合，覆盖工程流程、产品需求、交互原型和系统架构。每个技能以 `SKILL.md` 为入口。

## 技能目录

| 入口 | 适用任务 | 配套内容 |
|---|---|---|
| [product-dev 综合插件](product-dev/skills/product-dev/SKILL.md)（0.2.0） | 只说想法，由一个入口判断情况（新项目、加功能、修 bug、小改动、只改文档、装或升级工程套件）并按对应路线逐步推进 | 下面各组件和部分第三方内容的装配结果，供 Claude Code 与 Codex 作为插件安装；入口的每一步写明目标、原则、工具和过关证据 |
| [产品设计技能组](product-design-orchestrator/README.md) | 从想法推进到 PRD、交互原型、系统架构和实施交接 | 总控（唯一入口）与三个专业技能，共享协议和产物模板 |
| [engineering-kit](engineering-kit/SKILL.md) | 工程规则与闸门、开发流程和经验整理 | 同步工具、工程模板、流程规范和测试 |
| [evals](evals/cases.md) | 技能包自身的验证 | 一致性检查、插件构建检查与入口检查（`node --test evals/*.test.mjs`）、冲突矩阵、行为用例 |
| [组件清单](COMPONENTS.md) | 了解仓库由哪些组件构成、各自的来源与许可 | 自有组件与第三方组件两张表 |
| [语言风格 System Prompt](语言风格%20System%20Prompt.md) | 独立的中文表达约定 | 单文件 |

## 获取与使用

### 安装综合插件（推荐）

综合插件 `product-dev` 是唯一需要接入 agent 的部分。装好后只说想法，它会判断情况并按对应路线推进。

Claude Code（2.1.275 或更高版本）：

```
/plugin install product-dev --marketplace ac0033/skills
```

较早的版本分两步：`/plugin marketplace add ac0033/skills`，再 `/plugin install product-dev@ac0033-skills`。

Codex：

```bash
codex plugin marketplace add ac0033/skills
codex plugin add product-dev@ac0033-skills
```

### 单独使用某个组件

组件各自完整，可以不装综合插件单独使用，见[组件清单](COMPONENTS.md)。

```bash
git clone https://github.com/ac0033/skills.git
cd skills
```

把所需组件的目录放进 agent 的技能目录，或让支持读取文件的 Agent 打开它的 `SKILL.md`。

## 来源与许可

本仓库自有的内容以 MIT 许可发布，见 [LICENSE](LICENSE)。收录或改写的第三方内容保留各自的许可，不受该 MIT 许可覆盖。

### 综合插件收录的第三方内容

`product-dev/` 里收录了下列项目的内容。前三项是原文：我们只改了两个技能文件头的可见性字段（并加一行改动说明），没有收录 archify 的示例成品页和 impeccable 的会话钩子，其余原样。后两项是翻译和改写：入口技能的方法文档取用它们的方法，译为中文并按本插件的流程调整（部分段落接近直译），每份文件末尾注明出处和改动，没有收录它们的原文件。impeccable 的启动脚本首次运行时会联网下载它的引擎程序，archify 带有联网的更新检查，详见声明。逐项的来源、版本、改动、版权声明和许可全文见 [product-dev/THIRD_PARTY_NOTICES.md](product-dev/THIRD_PARTY_NOTICES.md)。

| 项目 | 收录内容 | 许可 |
|---|---|---|
| [impeccable](https://github.com/pbakaus/impeccable) 4.8.2 | 界面设计技能和它的四个子代理 | Apache-2.0 |
| [archify](https://github.com/tt-a1i/archify) 3.2.0 | 图表技能（含渲染器，不含示例成品页） | Apache-2.0，内含的品牌标识、字体等另有各自条款 |
| [feature-dev](https://github.com/anthropics/claude-plugins-official) 1.0.1 | 代码探索、方案设计、代码复审三个子代理 | Apache-2.0 |
| [ponytail](https://github.com/DietrichGebert/ponytail) 5.3.3 | 翻译和改写：最小改动规则、推送前自查清单 | MIT |
| [agent-skills](https://github.com/addyosmani/agent-skills) 0.6.15 | 翻译和改写：任务拆解、逐片循环、调试、代码评审与安全清单 | MIT |

### 外部工具

各组件单独使用时，会按名称调用或推荐下列外部工具。除上一节列出的已随综合插件收录的部分外，它们不随本仓库分发，需要各自安装，使用时遵守各自的许可；没装时按技能里写的替代做法执行。

| 工具 | 在这里的用途 | 与本仓库的关系 | 许可 |
|---|---|---|---|
| [feature-dev](https://github.com/anthropics/claude-plugins-official)（Anthropic 官方插件） | 代码探索、方案对比、独立复审的子代理 | 组件里只按名称调用；综合插件已收录三个子代理 | Apache-2.0 |
| [ponytail](https://github.com/DietrichGebert/ponytail) | 约束改动量、作者自查、全仓巡检 | 组件里只按名称推荐；综合插件收录了改写后的方法文档，不含其代码和钩子 | MIT |
| [archify](https://github.com/tt-a1i/archify) | 架构图与流程图 | 组件里只按名称推荐；综合插件已收录 | Apache-2.0 |
| [impeccable](https://github.com/pbakaus/impeccable) | 界面设计与界面复查 | 组件里只按名称推荐；综合插件已收录 | Apache-2.0 |
| [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | 任务拆解、调试、代码评审等方法的参考来源 | 综合插件收录了改写后的方法文档，不含其原文件 | MIT |

凡是改写或摘录第三方内容的文件，都在该文件末尾注明出处，并在插件的第三方声明里附上对应的版权声明和许可全文。
