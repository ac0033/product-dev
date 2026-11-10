---
name: engineering-kit
description: 工程能力包：向 Git 项目安装、升级和检查工程规则、闸门、钩子与模板；按项目规则编排开发交付，并把项目经验整理成可复用记录或套件变更。
argument-hint: "[项目目录] [--init] [--profile ts|python] [--check | --dry-run | --force | --from-tag <标签>]"
disable-model-invocation: true
---

# /engineering-kit：工程能力包

参数：`$ARGUMENTS`

按任务选择：安装或维护工程能力包；编排需求明确后的开发交付；记录用户可复用的经验；或将经验整理为套件变更。推送、合并、部署仍按用户授权与项目规则执行。

- 开发交付：先读 `references/process.md`；本机存在 `references/dev-flow.local.md` 且任务涉及对应项目时，再读其中项目专用流程。没有该文件时以通用流程和项目实际规则为准，不推断缺失的项目命令。
- 经验记录：读 `references/process.md` 的“经验记录”节；只在用户确有可复用经验时记录，按当前用户授权记录，不把普通对话视为持久化授权。

注意：本版套件的闸门仍执行旧流程，与当前目标流程不一致；安装或升级前先看第 5 节，已使用新流程的项目不要覆盖。

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

## 5. 日常闸门与当前适配状态

目标流程和各阶段检查以 `references/process.md` 第 4、5 节为唯一出处。当前 0.2.2 的脚本仍要求推送前单项复审，测试只执行配置的 `testCommand`，没有 CI 后双审查、最终 PR 绑定或受影响测试选择的通用实现；不能声称已自动支持目标流程。已采用新流程的项目优先使用自己的闸门，不要用本版本覆盖。

## 6. 套件的范围与局限

- 必须是 git 仓库：目标不是 git 仓库时拒绝安装，加 `--init` 才会自动 git init。
- 基准分支默认 `base: "auto"`：依次取 origin/HEAD、origin/main、origin/master、main、master；仓库还没有任何提交时，首次提交前的全部文件都按改动检查。没有远程也能用。
- 尚无源码与测试文件时，闸门不运行测试命令（记录为“无需测试”）；一旦出现源码，测试先行检查就会要求测试。本次改动里有代码文件、却没有任何文件匹配 `sourceGlobs` 与 `testGlobs` 时，闸门报错（多半是配置没按项目修改），不记为通过。
- Python 预设的测试命令是 `python -m pytest`：需要 Python 3.12 与 pytest 在 PATH 中。TypeScript 预设用 Node 24 的 `node --test` 直接运行 .test.ts，不做 tsc 类型检查。
- 源文件判断依赖 `sourceGlobs` 与 `testGlobs`，配置不准，闸门就不准。
- 测试先行靠“测试文件是否 import 了源文件的模块名”判断。经 index 再导出的间接引用识别不出来，应在豁免表里写理由。
- 注释检查：文件开头（连续注释行，或 Python 文档字符串含多行）要有至少 8 个字的说明；JS/TS 导出函数、类、常量、枚举前要紧挨注释。Python 只查文件头。
- Claude 钩子只防误操作，挡不住刻意绕过；终端直接 `git push` 不经过 Claude 钩子，靠 git pre-push 钩子兜底。
- 复审记录是本机约定，不是密码学证明。守住它靠 PR 里公开的复审摘要。
- 测试与复审记录放在各工作树自己的 git 目录（`engineering-gate/`），多个工作树互不覆盖，不进工作区；闸门锁放在 git 公共目录，同一仓库同时只跑一个闸门。
- 巡检的“已合并分支”判断基于补丁等价（git cherry），squash 合并后的分支需人工复核。
- 试装记录（PDFtranslator）：`references/trial-pdftranslator.md`。

## 7. 维护

- 源目录：`D:\4_Projects\ai_agent\skills\engineering-kit\`（ac0033/skills 仓库，分支 `feat/engineering-kit-bundle`，未推送）。生效副本：`D:\3_软件安装\ClaudeCodeData\skills\engineering-kit\`，与源目录保持一致。
- 验证：`cd "<kit>" && node --test tests/*.test.mjs`（changeset 测试在临时副本上运行）。
- 版本：`bundle.json` 的 `bundleVersion` 与 `kit/VERSION` 必须一致。发布前运行 `release.mjs --check`。
- 实践目录（约 60 条纪律的来源与适用范围）：`references/practices-catalog.md`。
- LearnMap 仍使用自己的闸门（`scripts/dev/gate/`），未迁移到本整包。迁移前不要在 LearnMap 上运行同步。
