---
name: engineering-kit
description: 工程能力包：把工程规则（AGENTS.md 标记块）、闸门脚本（测试先行、注释、复审记录、推送核对）、钩子、巡检、目录与文档模板整体装进任意 git 项目；整包升级、整包漂移检查、按版本标签回滚；反向把经验整理为变更集（用户经验直接应用，agent 经验先提案待确认）并发布版本。原则在全局 CLAUDE.md 的“工程纪律”和“经验提炼”，流程细则在 references/process.md。
argument-hint: "[项目目录] [--check | --dry-run | --force | --from-tag <标签>]"
disable-model-invocation: true
---

# /engineering-kit：工程能力包

参数：`$ARGUMENTS`

本技能只做两类事：把整包装进或升级到项目；以及把项目里得到的经验整理为变更集、发布为版本。它不授予超出项目规则的权限：推送、合并、部署仍按项目授权规则执行。

整包的清单是 `bundle.json`（组件、安装位置、所有权、整包版本）。下文 `<kit>` 指本技能的 `kit/` 目录，`<整包>` 指本技能目录。

## 1. 一键复用（装进新项目）

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
node "<kit>/tools/changeset.mjs" list                       # 待确认列表（推荐项在前）
node "<kit>/tools/changeset.mjs" apply <id> [--approved]    # 应用
node "<kit>/tools/release.mjs" --check                      # 检查整包可发布
node "<kit>/tools/release.mjs"                              # 提交整包目录并打标签（不推送、不开 PR）
```

变更集格式见 `kit/tools/changeset.mjs` 顶部注释。应用后不提交，由 `release.mjs` 提交。

## 5. 日常闸门（装进项目之后）

1. 先写测试，再写带注释的实现。
2. `node scripts/engineering/gate/gate.mjs`：静态检查（测试先行、注释）通过后运行 `testCommand`，结果绑定当前代码树。
3. 子代理复审（独立子代理，不把自己的结论交给它）；报告保存到仓库之外，含“结论”一节。
4. `node scripts/engineering/gate/review.mjs pass --reviewer <名> --report <报告> --summary "<一句话>"`。
5. `git push` 时 pre-push 钩子核对：范围内改动已提交；测试与复审记录对应当前代码；新文件在允许位置。
6. 收工与巡检：`node scripts/engineering/gate/hygiene.mjs`。巡检只报告，删除须先列清单经用户确认。

完整流程（开工、方案、文档规则、收工的经验提炼、巡检的语义一致性审、授权边界）见 `references/process.md`。

## 6. 套件的范围与局限

- 只支持 git 仓库。源文件判断依赖 `sourceGlobs` 与 `testGlobs`，配置不准，闸门就不准。
- 测试先行靠“测试文件是否 import 了源文件的模块名”判断。经 index 再导出的间接引用识别不出来，应在豁免表里写理由。
- 注释检查：文件开头（连续注释行，或 Python 文档字符串含多行）要有至少 8 个字的说明；JS/TS 导出函数、类、常量、枚举前要紧挨注释。Python 只查文件头。
- Claude 钩子只防误操作，挡不住刻意绕过；终端直接 `git push` 不经过 Claude 钩子，靠 git pre-push 钩子兜底。
- 复审记录是本机约定，不是密码学证明。守住它靠 PR 里公开的复审摘要。
- 记录放在 git 公共目录（`.git/engineering-gate/`），不进工作区。
- 巡检的“已合并分支”判断基于补丁等价（git cherry），squash 合并后的分支需人工复核。
- 试装记录（PDFtranslator）：`references/trial-pdftranslator.md`。

## 7. 维护

- 源目录：`D:\4_Projects\ai_agent\skills\engineering-kit\`（ac0033/skills 仓库，分支 `feat/engineering-kit-bundle`，未推送）。生效副本：`D:\3_软件安装\ClaudeCodeData\skills\engineering-kit\`，与源目录保持一致。
- 验证：`cd "<kit>" && node --test tests/*.test.mjs`（changeset 测试在临时副本上运行）。
- 版本：`bundle.json` 的 `bundleVersion` 与 `kit/VERSION` 必须一致。发布前运行 `release.mjs --check`。
- 实践目录（约 60 条纪律的来源与适用范围）：`references/practices-catalog.md`。
- LearnMap 仍使用自己的闸门（`scripts/dev/gate/`），未迁移到本整包。迁移前不要在 LearnMap 上运行同步。
