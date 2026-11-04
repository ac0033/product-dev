---
name: engineering-kit
description: 把工程纪律的机械执行部分一键装进任意 git 项目：测试先行检查、文件头与导出注释检查、测试记录与子代理复审记录（绑定代码树哈希）、推送前核对（Claude 钩子与 git pre-push 双保险）、合并入口拦截、豁免表。也用于检查已装版本是否漂移、升级套件。原则（不降标准、授权分级、完成四态）在全局 CLAUDE.md 的“工程纪律”一节，本套件只负责让这些规则可执行。
argument-hint: "[项目目录] [--check | --dry-run | --force | --no-hooks]"
disable-model-invocation: true
---

# /engineering-kit：把工程闸门装进项目

参数：`$ARGUMENTS`

本 skill 只做两件事：把套件装进目标项目，或者按套件的流程（写测试 → 闸门 → 子代理复审 → 记录 → 推送核对）帮项目跑闸门。它不授予任何超出项目规则的权限：推送、合并、部署仍按项目自己的授权规则执行。

## 1. 一键同步

套件目录就是本 skill 所在的 `kit/`。同步命令（把 `<项目>` 换成项目根目录的绝对路径）：

```bash
node "<skill目录>/kit/sync.mjs" --target "<项目>" --dry-run
node "<skill目录>/kit/sync.mjs" --target "<项目>"
```

先 `--dry-run` 看计划，确认后去掉它执行。之后检查漂移或升级：

```bash
node "<skill目录>/kit/sync.mjs" --target "<项目>" --check
```

同步会做的事：

- 把 `gate/*.mjs`、`hooks/*.mjs` 和 `VERSION` 装到 `<项目>/scripts/engineering/`，版本记在 `kit.lock.json`。
- 创建 `engineering.config.json`（项目配置）和 `scripts/engineering/exempt.json`（豁免表）。只在首次创建，之后归项目所有，同步不覆盖。
- 在 `.claude/settings.json` 追加两个钩子（推送核对、编辑提醒），保留原有内容；JSON 不合法时整体报错，不写入任何文件。
- 在 `.git/hooks/pre-push` 安装推送核对。已有其他 pre-push 钩子时不覆盖，只给出要加的那一行。
- 项目里改过套件文件、且不是套件记录的版本时，默认不覆盖并报告冲突。确认要覆盖再加 `--force`。

同步后必须做的一件事：打开 `engineering.config.json`，按项目目录改写 `base`、`sourceGlobs`、`testGlobs`、`reviewIgnore`、`testCommand`，需要环境变量时写进 `testEnv`（例如 Python 项目设 `PYTHONPATH`）。`reviewIgnore` 只应包含纯文档（如 `**/*.md`、`docs/**`）：依赖、配置、锁文件的改动也必须有记录。默认值是 TypeScript 加 `npm test`，不对会让闸门误判。Python 项目把 `sourceGlobs` 改成 `**/*.py`，测试文件按项目习惯写进 `testGlobs`。

## 2. 日常流程

这套流程跟项目的开发规则配套，闸门只负责机械核对：

1. 先写测试，再写带注释的实现。
2. 运行闸门：`node scripts/engineering/gate/gate.mjs`。它先做静态检查（测试先行、注释），通过后运行 `testCommand`，把结果绑定到当前代码树哈希。
3. 子代理复审：由独立子代理（`feature-dev:code-reviewer` 或 `/code-review`）复审本次改动，不把自己的结论交给它。报告保存到仓库之外的临时文件，包含“结论”一节。
4. 登记复审：`node scripts/engineering/gate/review.mjs pass --reviewer feature-dev:code-reviewer --report <报告文件> --summary "<一句话>"`。报告不少于配置的字数、结论写“不通过”则拒绝登记为 pass。
5. 推送：`git push` 时钩子自动核对。改了源文件就要重跑第 2 步，复审也要重做，因为记录绑定代码树哈希。只改文档不会使记录失效。

豁免：在 `scripts/engineering/exempt.json` 里按路径写理由。每条都要在复审时逐条核对，不接受“先豁免、以后补”。

合并：套件只拦截直接合并（`gh pr merge`、`gh api …/pulls/<n>/merge`）。项目应有自己的合并入口，并在那里等 CI 全部通过后才合并。

## 3. 套件的范围与局限

- 只支持 git 仓库。源文件判断依赖 `sourceGlobs` 与 `testGlobs`，配置不准，闸门就不准。
- 测试先行靠“测试文件是否 import 了源文件的模块名”判断。经 index 再导出的间接引用识别不出来，应在豁免表里写理由。
- 注释检查：文件开头（连续注释行，或 Python 文档字符串含多行）要有至少 8 个字的说明；JS/TS 导出函数、类、常量、枚举前要紧挨注释（跳过 interface 与 type）。Python 只查文件头。
- Claude 钩子只防误操作，挡不住刻意绕过；终端直接 `git push` 不经过 Claude 钩子，靠 git pre-push 钩子兜底。
- 复审记录是本机约定，不是密码学证明。守住它靠 PR 里公开的复审摘要。
- 记录放在 git 公共目录（`.git/engineering-gate/`），不进工作区。同一仓库的所有工作树共用，靠树哈希区分内容。
- 闸门运行期间不要修改代码，否则记录作废（会在结果里说明）。
- 推送核对拒绝的情况：范围内有未提交改动（推送的是提交，核对的必须是同一份代码）；基准分支（`base`）解析不了（不会放行）；git 状态读取失败（不会放行）。
- 试装记录（PDFtranslator，2026-11-04）：见 `ai_agent/skills/engineering-kit/references/trial-pdftranslator.md` 的“已知上线后事项”。

## 4. 验证套件本身

套件自带测试，改套件后先跑：

```bash
cd "<skill目录>/kit"
node --test tests/gate.test.mjs tests/sync.test.mjs
```

测试在临时 git 仓库里跑真实流程，不 mock git。

## 5. 维护

- 实践目录（约 60 条，分层与通用度）：[references/practices-catalog.md](references/practices-catalog.md)。想知道某条纪律从哪来、适用于哪类项目，看这里。
- 源目录：`D:\4_Projects\ai_agent\skills\engineering-kit\`（ac0033/skills 仓库）。生效副本：`D:\3_软件安装\ClaudeCodeData\skills\engineering-kit\`。改套件要两边一致。
- 升级套件时改 `kit/VERSION`，再用同步命令升级各项目。已由项目修改的文件会被标为冲突，逐个确认。
- LearnMap 当前使用自己的闸门（`scripts/dev/gate/`），还没迁移到本套件。迁移前不要在 LearnMap 上运行同步，以免覆盖它的闸门。
