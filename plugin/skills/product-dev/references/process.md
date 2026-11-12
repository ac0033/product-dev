# 流程细则

入口技能各步骤的操作细则，按需读对应的节。贯穿全程的规则只写在工程流程规则块里（R1–R10），本文只写各步怎么做，引用编号，不复述。能用脚本或钩子强制的，就不靠自觉。

通用的流程细则只写在套件的流程文档 [process.md](../../engineering-kit/references/process.md) 里，本文不复述，只写入口自己的内容：下面的对照表、配置闸门、测试的四个阶段。经入口走流程时，按对照表去读对应的节；两者说法不同时，以项目自己的规则和闸门的实际判定为准（R1），并把不同之处报告出来。

命令里的 `<项目>` 指项目根目录；套件的闸门脚本装在 `<项目>/scripts/engineering/gate/` 下。套件的安装、升级、漂移检查、回滚、变更集与发布的命令只写在内部技能 [engineering-kit](../../engineering-kit/SKILL.md) 的第 1 到 4 节；其中回滚、变更集与发布要在套件源仓库的检出里做，见入口第 7 节。

## 入口步骤对照

| 入口的步骤或主题 | 套件流程文档里的位置 |
|---|---|
| 授权边界 | [process.md](../../engineering-kit/references/process.md) 第 10 节 |
| 开工检查；执行位置与排程 | [process.md](../../engineering-kit/references/process.md) 第 1 节，其中 [process.md](../../engineering-kit/references/process.md)“执行位置与排程” |
| 澄清问题、功能契约、方案对比、用户选定方案 | [process.md](../../engineering-kit/references/process.md) 第 2 节 |
| 逐片开发（闸门查的三件事；做法见 [build.md](build.md)） | [process.md](../../engineering-kit/references/process.md) 第 3 节 |
| 机械闸门、PR 与 CI、独立复审、合并（目标顺序、审查分档、两种复审流程、测试模式与结果复用、闸门输出的读法） | [process.md](../../engineering-kit/references/process.md) 第 4 节；各阶段跑哪种测试见本文“测试的四个阶段” |
| 验收与发布、回归入库 | [process.md](../../engineering-kit/references/process.md) 第 5 节 |
| 文档与目录 | [process.md](../../engineering-kit/references/process.md) 第 6 节 |
| 合并与收工、经验提炼 | [process.md](../../engineering-kit/references/process.md) 第 7 节，其中 [process.md](../../engineering-kit/references/process.md)“经验记录” |
| 巡检（语义一致性审的任务书见 [review.md](review.md)） | [process.md](../../engineering-kit/references/process.md) 第 8 节 |

## 配置闸门

对应入口的“配置闸门”。架构选定技术栈之后，改项目的 `engineering.config.json`：

| 字段 | 填什么 |
|---|---|
| `modules.gate.testCommand`、`testEnv` | 本项目跑测试的命令和它需要的环境变量。Python 项目在 `testEnv` 里设 `PYTHONPATH` |
| `modules.gate.testGroups` | 可选。测试分组，每项 `{ name, paths, command }`：`paths` 是这一组覆盖的源码和测试的 glob，`command` 只跑这一组的测试。配了才能用 `gate.mjs --affected` 按影响范围测试；分组覆盖不全、拿不准依赖关系的项目不配，照常跑全量 |
| `layout.sourceGlobs`、`testGlobs` | 源文件和测试文件的匹配规则。Python 项目把 `sourceGlobs` 改成 `**/*.py` |
| `rules.reviewIgnore` | 只应包含纯文档。默认值（`**/*.md`、`docs/**`）把规则、技能正文、提示词这类会改变 agent 行为的 Markdown 也算成文档：闸门不要求为它们复审，合并入口还会把只改它们的 PR 当成只改文档放行。以这类文档为主的项目，把它收窄到真正的纯文档（例如只留 `docs/**` 和说明文件）。它是判定策略字段：闸门按基准提交上的版本判定，分支里的修改合入主干后才生效；项目配置、豁免表和 `scripts/engineering/**` 永远在闸门范围内 |
| `modules.review.reviewers` | 确认名单里有 `product-dev:code-reviewer`，否则用它做的复审登记不了。套件 0.5.0 起新装的项目默认已有；更早安装的项目同步时不改项目配置，要手动加（见 [review.md](review.md) 第 1 节）；名单按基准提交上的配置判定，在功能分支里加要合入主干后才生效 |
| `modules.gate.reviewFlow` | 默认 `pre-push`；有 GitHub 远程、已登录的 `gh` 且 PR 上有 CI 检查的项目可以改成 `pr`（建议项，由用户决定或按授权采用推荐）；闸门按基准提交上的配置判定，改动合入主干后才生效 |

同一步还要定两件事，都由用户决定：要不要建远程仓库和 CI（建远程仓库是外部动作，先得到批准；不建的话“PR 与 CI”一步做不了，要如实写未执行）；`pre-push` 流程下由谁、经哪个入口合并，定了就写进项目的 AGENTS.md。安装时没加 `--profile` 的项目没有脚手架，包清单、测试框架等按选定的技术栈自己建，默认的测试命令也要相应改掉。

配完验证闸门拦得住：临时放一个必然失败的测试，跑 `node scripts/engineering/gate/gate.mjs`，确认它报失败；撤掉这个测试再跑一次，确认通过。两次输出都留作证据。改动里有代码文件、却没有任何文件匹配 `sourceGlobs` 与 `testGlobs` 时闸门会报错，多半是这两项没按项目改。

## 测试、审查与合并

目标顺序、审查分档、两种复审流程的命令、测试模式与结果复用，都在 [process.md](../../engineering-kit/references/process.md) 第 4 节。复审怎样派发、任务书和报告格式见 [review.md](review.md)。入口各阶段用哪种测试模式，见下面的“测试的四个阶段”。

### 测试的四个阶段

对应入口的“逐片开发”“机械闸门”“PR 与 CI”和复审后的修复。每个阶段只跑这个阶段需要的：每轮复审都重跑全量，既费时也不增加证据。

| 阶段 | 什么时候 | 跑什么 | 证据 |
|---|---|---|---|
| 开发中 | 逐片开发，每片写完 | 只跑与本片相关的快测：本片的测试文件，或它所属分组的 `command` | 相关测试通过 |
| 首次候选 | 推送前第一次过闸门 | 全量 `gate.mjs`；再做一次变异检查：把本次新增的一个关键条件反过来，只跑相关测试，它们应当失败，看到失败后恢复原样 | 闸门输出；变异检查反转了哪个条件、哪条测试失败的输出，写进 PR 描述，并作为复审任务书的验证证据 |
| 修复后 | 复审要求修改、改完之后 | 修复后一律运行 `gate.mjs --affected`，判断不了影响范围时它自动改跑全量；只改 `reviewIgnore` 之内的文件时，闸门会自动沿用已有记录 | 闸门输出（按哪些分组跑，或改跑全量的原因） |
| 最终提交 | PR 的最终提交；`pre-push` 流程的最终推送 | CI 在最终提交上跑全量；`pre-push` 流程最终推送前须有一次全量 `gate.mjs` 的通过记录 | CI 结果；推送核对通过 |

- 变异检查反转后相关测试仍然全过，说明缺用例：先补上能拦住它的测试再进复审，不留给复审者去发现。
- 复审者不重跑全量测试：闸门记录和 CI 结果是共用的测试证据，能运行命令的复审者可以做针对性的复现（单个测试、单个场景），不能运行的只核对证据并在报告里写明没有复现。
