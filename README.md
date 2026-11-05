# Agent Skills

自研与收录的 Agent 技能集合。每个技能以 `SKILL.md` 为入口，按任务需要提供写作、讲解或汇报规则；部分技能附有脚本与示例。

## 技能目录

| 入口 | 适用任务 | 配套内容 |
|---|---|---|
| [systems-thinking](systems-thinking/SKILL.md) | 系统性构思、计划与讲解，统一用"层次→维度→板块→具体事项"组织 | 框架指南、写作与讲解规范、模板和示例 |
| [cognitive-receiver](cognitive-receiver/SKILL.md) | 向用户讲解复杂内容时降低认知负荷，维护双方共通的概念 | 单文件 Skill |
| [goal-driven-development](goal-driven-development/SKILL.md) | 以终为始开发功能：目标与标准 → 问题拆解 → 借鉴论文与开源 → 验证集迭代 → 测试集验收 | 目标与标准、拆解、来源筛选、验证与测试的参考，以及计划/日志/报告模板 |
| [产品设计技能组](product-design-orchestrator/README.md) | 从想法推进到 PRD、交互原型、系统架构和实施交接 | 总控与三个专业技能，共享协议、产物模板和行为验收用例 |
| [data-science-project](data-science-project/SKILL.md) | 数据科学项目的全周期规划、执行、验收与解释 | 工作流、数据审查、EDA 与验收报告规范 |
| [engineering-kit](engineering-kit/SKILL.md) | 工程规则与闸门、开发流程和经验整理 | 同步工具、工程模板、流程规范和测试 |
| [publish-private-project](publish-private-project/SKILL.md) | 把私有项目首次公开到 GitHub：隐私核查、清理、全新历史、发布配套 | 核查清单与仓库配套模板 |
| [submit](submit/SKILL.md) | 按检查清单提交快照；参数为 `1` 或 `同步` 时再推送到远程，没有远程仓库就新建一个私有仓库 | 检查清单 [`checklist.md`](submit/checklist.md) |
| [tidy-docs](tidy-docs/SKILL.md) | 整理项目：精简 agent 规则文件并补入新原则，同步用户文档与 agent 记忆，清理临时文件，过时文件归档到 `archive/` | 单文件 Skill |
| [synchronous](synchronous/SKILL.md) | 把 skill 或通用原则同步到本机各 agent（Claude Code、Codex、WorkBuddy、Pi） | 单文件 Skill |
| [api](api/SKILL.md) | 为项目暴露对外接口：plugin、skills、MCP、CLI、HTTP API、SDK；默认由 agent 按项目情况选择，也可用参数指定 | 单文件 Skill |

## 获取与使用

```bash
git clone https://github.com/ac0033/skills.git
cd skills
```

让支持读取文件的 Agent 打开所选技能的 `SKILL.md`，并提供任务与材料。

submit、tidy-docs、synchronous、api 四个技能适合封装成指令，例如在 Claude Code 中把技能目录复制到 `~/.claude/skills/` 后，就可以用 `/submit 1` 这样的形式调用。Agent 第一次使用这几个技能时，会先问用户是否要封装成指令。不封装也可以正常使用，参数写在任务说明里即可。插件、技能安装目录和调用方式取决于宿主。

## 来源与许可

各子目录保留各自的来源与许可文件，见对应 README、SKILL 和 LICENSE；本仓库不为所有收录内容统一声明新的许可。
