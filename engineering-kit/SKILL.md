---
name: engineering-kit
description: 工程能力包的管理入口：向 Git 项目安装、升级、检查和回滚工程规则、闸门、钩子与模板，并把经验整理成套件变更和发布。日常开发交付不从这里进，走 project-flow。
argument-hint: "[项目目录] [--init] [--profile ts|python] [--check | --dry-run | --force | --from-tag <标签>]"
disable-model-invocation: true
---

# /engineering-kit：工程能力包

参数：`$ARGUMENTS`

本技能只管套件本身：安装、升级与漂移检查、回滚、变更集与发布、维护。开发交付（分流、需求与方案、开发、自查、复审、合并、验收与发布）由 [project-flow](../project-flow/SKILL.md) 负责，流程细则在它的 `references/` 下。推送、合并、部署按用户授权与项目规则执行。

- 经验记录：读 [practices.md](references/practices.md)；只在用户确有可复用经验时记录。
- `references/*.local.md` 是只留本机的记录（项目专用流程、试装与验收记录、实践来源），不进仓库。本机存在 `references/dev-flow.local.md` 且任务涉及对应项目时，开发交付时一并读它；没有该文件时以通用流程和项目实际规则为准，不推断缺失的项目命令。

安装或升级前先看第 5 节的适配状态与局限，已使用自有闸门的项目不要覆盖。

整包的清单是 `bundle.json`（组件、安装位置、所有权、整包版本）。下文 `<kit>` 指本技能的 `kit/` 目录，`<整包>` 指本技能目录。

## 1. 一键复用（装进新项目）

从零开始（推荐，项目第一天就配好规则、结构与技术栈）：

```bash
node "<kit>/sync.mjs" --target "<项目>" --init --profile ts      # 空目录：git init -b main + TypeScript 配置与脚手架
node "<kit>/sync.mjs" --target "<项目>" --init --profile python  # 空目录：git init -b main + Python（pytest）配置与脚手架
```

`--profile` 只在首次创建 engineering.config.json 时生效；配置已存在时不改写，并提示手动修改。脚手架文件（package.json、pyproject.toml、.gitignore）只在不存在时创建。预设定义在 `kit/tools/presets.mjs`。

已有项目（已是 git 仓库）也可以直接装，不加 `--profile`，然后按下面的说明手动调整配置：

```bash
node "<kit>/sync.mjs" --target "<项目>" --dry-run   # 先看计划
node "<kit>/sync.mjs" --target "<项目>"             # 执行
```

同步是原子事务：先校验整包（清单、源文件、JSON），再统一写入，再冒烟测试，最后写锁文件 `scripts/engineering/kit.lock.json`。任一步失败，已写入的文件全部恢复原样。存在冲突（项目里改过套件文件）时整包一个文件也不写，列出冲突；确认后加 `--force`。

所有权：

| 所有者 | 组件 | 同步时的行为 |
|---|---|---|
| 套件（kit） | 闸门脚本、钩子、VERSION、git pre-push | 覆盖更新；项目有未登记的修改则冲突 |
| 规则块（block） | AGENTS.md、CLAUDE.md（已存在时） | 只替换 `<!-- engineering-kit:begin vX --> … end` 之间的内容，块外项目内容不动 |
| 项目（project） | engineering.config.json、豁免表、docs 索引、阶段目录、模板 | 只在首次创建；配置格式不同时只做格式迁移，取值保留 |
| 共享（shared） | .claude/settings.json | 只追加本套件的钩子 |

同步后要做的一件事：按项目修改 `engineering.config.json` 的 `modules.gate.testCommand` 与 `testEnv`、`layout.sourceGlobs` 与 `testGlobs`，以及 `rules.reviewIgnore`（只应包含纯文档）。Python 项目把 `sourceGlobs` 改成 `**/*.py`，并在 `testEnv` 里设 `PYTHONPATH`。

## 2. 一键更新与漂移检查

```bash
node "<kit>/sync.mjs" --target "<项目>" --check       # 整包漂移检查，列出每一项差异（有差异退出码 1）
node "<kit>/sync.mjs" --target "<项目>"               # 升级到当前整包版本（同一命令）
```

漂移检查逐组件核对：套件文件是否逐字节一致、标记块版本与内容、配置格式、阶段目录与模板、钩子、锁文件版本。

## 3. 回滚到某个版本

版本由源仓库的标签标记（`engineering-kit-vX.Y.Z`）。回滚与升级用同一条原子路径：

```bash
node "<kit>/sync.mjs" --target "<项目>" --from-tag engineering-kit-v0.1.0 --dry-run
node "<kit>/sync.mjs" --target "<项目>" --from-tag engineering-kit-v0.1.0
```

回滚时，配置格式随目标版本回退（profile → 扁平），上一版本里没有的文件会被删除（未被改过的才删，改过的报冲突）。

## 4. 反向提炼：变更集与发布（源端）

经验按来源分两条路，但走同一条原子路径（备份 → 写入 → 运行套件测试 → 通过则移入已应用记录，失败则整体恢复）：

- 用户本人的决定或做法：登记后直接应用。
- agent 总结的经验：先登记为提案，批量列给用户确认（推荐项在前），用户确认后才以 `--approved` 应用。

```bash
node "<kit>/tools/changeset.mjs" propose <变更集.json>      # 登记为提案
node "<kit>/tools/changeset.mjs" list                       # 待确认列表（推荐项在前）
node "<kit>/tools/changeset.mjs" apply <id> [--approved]    # 应用
node "<kit>/tools/release.mjs" --check                      # 检查整包可发布
node "<kit>/tools/release.mjs"                              # 提交整包目录并打标签（不推送、不开 PR）
```

变更集格式见 `kit/tools/changeset.mjs` 顶部注释。应用后不提交，由 `release.mjs` 提交。

## 5. 维护

- 源目录是源仓库（ac0033/skills）的 `engineering-kit/`；本机若另有生效副本（如 Claude Code 的技能目录），改动后把源目录复制过去，保持一致。
- 验证：`cd "<kit>" && node --test tests/*.test.mjs`（changeset 测试在临时副本上运行）；技能包的一致性检查在仓库根运行 `node --test evals/consistency.test.mjs`。
- 版本：`bundle.json` 的 `bundleVersion` 与 `kit/VERSION` 必须一致。发布前运行 `release.mjs --check`。
- 整包发布只提交套件目录，不推送，不开 PR，除非用户明确要求。
- 已有自己闸门的项目不要直接运行同步；迁移前先比对两边规则，具体项目的情况记在本机的 `references/*.local.md`。

### 适配状态

闸门按项目配置 `modules.gate.reviewFlow` 走两种复审流程之一：默认 `pre-push`（推送前单项复审），或 `pr`（CI 后双审与合并入口）。两种流程各步核对什么、用什么命令，以 project-flow 的 [process.md](../project-flow/references/process.md)“测试、审查与合并”节为唯一出处。把 `reviewFlow` 改回 `pre-push` 即恢复旧流程。

尚未实现：受影响测试选择（推送前仍跑配置的 `testCommand` 全量）；同一 PR 三轮审查的自动计数。真实验证：`pr` 流程已由用户在带 CI 的 GitHub 仓库里走通（2026-11-10，用户报告，见 `references/contract-pr-review-merge.md`）。

### 范围与局限

- 必须是 git 仓库：目标不是 git 仓库时拒绝安装，加 `--init` 才会自动 git init。
- 基准分支默认 `base: "auto"`：依次取 origin/HEAD、origin/main、origin/master、main、master；仓库还没有任何提交时，首次提交前的全部文件都按改动检查。没有远程也能用。
- 尚无源码与测试文件时，闸门不运行测试命令（记录为“无需测试”）；一旦出现源码，测试先行检查就会要求测试。本次改动里有代码文件、却没有任何文件匹配 `sourceGlobs` 与 `testGlobs` 时，闸门报错（多半是配置没按项目修改），不记为通过。
- Python 预设的测试命令是 `python -m pytest`：需要 Python 3.12 与 pytest 在 PATH 中。TypeScript 预设用 Node 24 的 `node --test` 直接运行 .test.ts，不做 tsc 类型检查。
- 源文件判断依赖 `sourceGlobs` 与 `testGlobs`，配置不准，闸门就不准。
- 测试先行靠“测试文件是否 import 了源文件的模块名”判断，识别不出的间接引用怎样处理见 project-flow 流程细则的“开发细则”节。
- 注释检查：文件开头（连续注释行，或 Python 文档字符串含多行）要有至少 8 个字的说明；JS/TS 导出函数、类、常量、枚举前要紧挨注释。Python 只查文件头。
- Claude 钩子只防误操作，挡不住刻意绕过；终端直接 `git push` 不经过 Claude 钩子，靠 git pre-push 钩子兜底。
- 复审记录是本机约定，不是密码学证明；复审者名字由登记者填写，套件不验证它确是独立子代理。守住它靠 PR 里公开的复审摘要。
- 测试记录与 `pre-push` 流程的复审记录放在各工作树自己的 git 目录（`engineering-gate/`），多个工作树互不覆盖，不进工作区；闸门锁与 `pr` 流程的 PR 审查记录（`engineering-gate/pr/<编号>/`）放在 git 公共目录，所有工作树共用：同一仓库同时只跑一个闸门，复审与合并可以在不同工作树进行。
- `pr` 流程只支持 GitHub（经 `gh`）；`gh` 不存在或调用失败时登记与合并都报错，不放行。只改文档的 PR 和各风险档位怎样审，见适配状态所指的那一节。
