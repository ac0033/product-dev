---
name: engineering-kit
description: 工程能力包：向 Git 项目安装、升级和检查工程规则、闸门、钩子与模板；按项目规则编排开发交付，并把项目经验整理成可复用记录或套件变更。
argument-hint: "[项目目录] [--init] [--profile ts|python] [--check | --dry-run | --force | --from-tag <标签>]"
disable-model-invocation: true
---

# /engineering-kit：工程能力包

参数：`$ARGUMENTS`

按任务选择：安装或维护工程能力包；编排需求明确后的开发交付；记录用户可复用的经验；或将经验整理为套件变更。推送、合并、部署仍按用户授权与项目规则执行。

- 开发交付：先读 `references/process.md`；本机存在 `references/dev-flow.local.md` 且任务涉及对应项目时，再读其中项目专用流程。`references/*.local.md` 是只留本机的记录（项目专用流程、试装与验收记录、实践来源），不进仓库。没有该文件时以通用流程和项目实际规则为准，不推断缺失的项目命令。
- 经验记录：读 `references/process.md` 的“经验记录”节；只在用户确有可复用经验时记录，按当前用户授权记录，不把普通对话视为持久化授权。

注意：闸门有两种复审流程（`modules.gate.reviewFlow`）：默认 `pre-push` 是推送前复审（推送核对只要求代码复审）；`pr` 提供 CI 后双审与合并入口。安装或升级前先看第 5 节，已使用自有闸门的项目不要覆盖。

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

同步后要做的一件事：按项目修改 `engineering.config.json` 的 `modules.gate.testCommand` 与 `testEnv`、`layout.sourceGlobs` 与 `testGlobs`，以及 `rules.reviewIgnore`（只应包含纯文档）；要按影响范围测试的，再配可选的 `modules.gate.testGroups`（每项 `{ name, paths, command }`，供 `gate.mjs --affected` 使用）。Python 项目把 `sourceGlobs` 改成 `**/*.py`，并在 `testEnv` 里设 `PYTHONPATH`。

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

目标流程和各阶段检查以 `references/process.md` 第 4、5 节为唯一出处，两种流程的命令也写在第 4 节。当前版本的闸门按项目配置 `modules.gate.reviewFlow` 走其中一种：

| 流程 | 推送核对（`verify.mjs`） | 复审登记（`review.mjs`） | 合并 |
|---|---|---|---|
| `pre-push`（默认） | 静态检查、全量测试记录、代码复审记录（pass 或用户接受风险的 accept），都绑定当前代码树和基线（基准提交）；pre-push 钩子另核对实际推送的提交 | 推送前登记代码复审（可另登记一致性审或延期，推送核对不要求），记录里写明分支、HEAD 提交号和文档内容哈希；按分支计复审轮次（口径见第 6 节） | 套件不提供入口；钩子拒绝直接 `gh pr merge`，按项目约定的入口合并 |
| `pr` | 静态检查、测试记录（绑定代码树和基线，按影响范围的也认）；不要求复审记录 | CI 全部通过后按 PR 登记代码复审与一致性审，绑定 PR 最终提交；按 PR 计复审轮次（口径见第 6 节） | `merge.mjs <PR>` 核对 PR 打开、CI 全过、两项记录与最终提交一致（代码复审之后只改文档的仍认；accept 按用户决定放行；只改文档的 PR 不要求记录）后执行 `gh pr merge --match-head-commit` |

`pr` 流程需要 GitHub 远程、已登录的 `gh`，且 PR 上有 CI 检查（一项都没有视为未通过）；不满足的项目留在 `pre-push`。要恢复旧流程，须在主干上把 `reviewFlow` 改回 `pre-push`，合入后才生效；这个改动的 PR 本身仍按当时的 `pr` 流程经 `merge.mjs` 合并，合并入口用不了时由用户合并或走项目约定的入口。

0.6.0 起已实现：按测试分组的受影响测试选择（`gate.mjs --affected`，判断不了影响范围时自动改跑全量，`pre-push` 流程最终推送前仍须全量）与结果复用；复审轮次的自动计数与拦截（`modules.review.maxReviewRounds`，默认 3；0.6.1 起按登记过不通过的不同被审内容计，口径见第 6 节）。这两项只有套件自己的测试覆盖，尚未在真实项目里走过。真实验证：`pr` 流程已由用户在带 CI 的 GitHub 仓库里走通（2026-11-10，用户报告，见 `references/contract-pr-review-merge.md`）。已采用自有闸门的项目优先使用自己的闸门，不要用本版本覆盖。

## 6. 套件的范围与局限

- 必须是 git 仓库：目标不是 git 仓库时拒绝安装，加 `--init` 才会自动 git init。
- 基准分支默认 `base: "auto"`：依次取 origin/HEAD、origin/main、origin/master、main、master；仓库还没有任何提交时，首次提交前的全部文件都按改动检查。没有远程也能用。生效的 `base` 以默认主干（按同样的顺序找到的第一个）上的项目配置为准，被审分支改它不生效；找不到默认主干或主干上还没有配置文件（首次安装）时才用工作区的值；主干上的配置读不出或不合法时报错。工作区的值与生效值不同时，闸门（`gate.mjs`）和推送核对（`verify.mjs`）各输出一行基准提示（复审登记和合并入口不输出），要改基准须先在主干上改。
- 尚无源码与测试文件时，闸门不运行测试命令（记录为“无需测试”）；一旦出现源码，测试先行检查就会要求测试。本次改动里有代码文件、却没有任何文件匹配 `sourceGlobs` 与 `testGlobs` 时，闸门报错（多半是配置没按项目修改），不记为通过。
- Python 预设的测试命令是 `python -m pytest`：需要 Python 3.12 与 pytest 在 PATH 中。TypeScript 预设用 Node 24 的 `node --test` 直接运行 .test.ts，不做 tsc 类型检查。
- 源文件判断依赖 `sourceGlobs` 与 `testGlobs`，配置不准，闸门就不准。
- 测试先行靠“测试文件是否 import 了源文件的模块名”判断。经 index 再导出的间接引用识别不出来，应在豁免表里写理由。断言检查只查本次改动的测试文件，已删除的、`reviewIgnore` 之内的、`__init__.py` 和 `conftest.py` 不查；它只用一组宽松的正则找断言痕迹（assert、expect、should 等），不理解代码：注释里写了 assert 会被当成有断言，断言写在被导入的辅助函数里会被当成没有；后一种在豁免表的 `assertions` 段写理由。测试用例数减少只提示、不拦截：同一路径按基准提交上的同一文件比较；改名按 git 配上的改名对（含暂存的 `git mv`）比较改名前的文件；配不上对的（内容改动大，或只在工作区移动、没有 `git add`）按已删除与新增测试文件的用例总数比较，只删测试文件、没有新增的同样提示。
- 按影响范围测试只认测试分组的 `paths`：分组配得不全时，漏掉的依赖关系闸门看不出来（例如分组 A 的代码被分组 B 的测试间接用到）；依赖清单只列常见语言的文件名。拿不准的项目不配分组，照常跑全量。改动文件一律按 `git diff --no-renames` 取：改名算旧路径删除加新路径新增，所以含改名的分支，树哈希与 0.5.1 算出的不同，升级后旧记录对不上，重跑一次闸门即可。暂存而未提交的改名同样按两个路径算：推送核对判断“范围内有未提交改动”时，旧路径在范围内也算（例如把源文件 `git mv` 进 docs/ 只暂存不提交）；已提交的修改加上只暂存的改名也一样，旧路径计入未提交改动。
- 结果复用只比较闸门范围内文件的内容和测试配置摘要（`testCommand`、`testEnv`、`testGroups`）：依赖目录（如 node_modules）、运行时版本、其他环境变量变了，闸门看不出来，要重跑时加 `--force`。同一棵树上最近一次运行未通过时不沿用任何记录（不稳定的测试失败一次，下一次运行就会真的重跑）。
- 注释检查：文件开头（连续注释行，或 Python 文档字符串含多行）要有至少 8 个字的说明；JS/TS 导出函数、类、常量、枚举前要紧挨注释。Python 只查文件头。
- Claude 钩子只防误操作，挡不住刻意绕过；终端直接 `git push` 不经过 Claude 钩子，靠 git pre-push 钩子兜底。pre-push 钩子把 stdin 里实际推送的引用交给 `verify.mjs --pre-push` 核对：分支推送的提交必须是当前 HEAD 或已在基准分支里，否则拒绝；标签推送不查引用（工作区核对照常），只删除远端引用（分支或标签）的推送直接放行。Claude 钩子拒绝跳过 git 钩子的推送（`git push --no-verify` 及从 `--no-veri` 起的前缀缩写、`git -c core.hooksPath=… push`），`-n`（即 `--dry-run`）照常核对。判断按 shell 规则逐段切词：引号里的文字不算参数，但被引号整个包住的词（如 `"--no-verify"`）照样算；core.hooksPath 只认 git 与 push 之间的 `-c`、`--config-env` 全局选项，以及同一条命令里用环境变量（`GIT_CONFIG_KEY_<n>`、`GIT_CONFIG_PARAMETERS`）设的值。认不出、因而拦不住的写法：换行续行把 `git push` 和选项拆在几行；子命令替换和变量展开；git 别名（如 `git -c alias.p="push --no-verify" p`，或配置里事先定义的别名）。推送引用只在 git pre-push 钩子里核对：钩子没装（安装时用了 `--no-hooks`，或已有别的 pre-push 钩子而没加核对行）时，Claude 钩子只核对工作区，推别的分支或显式 refspec 拦不住，整包漂移检查会把缺失的钩子报为 missing；事先用 `git config core.hooksPath` 改钩子目录这类持久配置也拦不住。
- 闸门通过时先打印测试先行检查、注释检查、断言检查三行，前两行写明各检查、豁免了几个本次改动的源文件（注释检查不看 `reviewIgnore` 之内的和已删除的，两行数字可以不同），断言检查一行写明查了几个本次改动的测试文件；用例数减少时多一行提示。之后按情况是测试结果一行，前面可能多一行说明（改跑全量的原因，或按影响范围跑了哪些分组），沿用已有记录时这一行换成“沿用已有通过记录”；静态检查不过时不跑测试。
- 判定依据在 `lib.mjs` 的 `loadConfig` 一处得出，`gate.mjs`、`verify.mjs`、`review.mjs`、`merge.mjs`、巡检和钩子共用：判定策略字段 `reviewIgnore`、`reviewFlow`、`reviewers`、`reviewMinChars`、`reviewKeyword`、`maxReviewRounds` 取基准提交上的项目配置，基准上没有配置（首次安装）时才用工作区的，读不出或不合法时报错；测试命令、测试分组、glob 等其余字段用工作区的值（它们随功能分支变化是正常的，配置文件又永远在闸门范围内，改了要过复审）。闸门范围只有一个口径：项目配置、豁免表和 `scripts/engineering/**` 永远在范围内。分支改自己的判定策略要合入主干后才生效，工作区的值与生效值不同时，闸门和推送核对各输出一行判定策略提示（复审登记和合并入口不输出）。树哈希里子模块按它指向的提交号计入。
- 测试与复审记录写明基线（基准提交）：合入新主干或变基后旧记录作废，提示“基线已变化”。测试运行期间范围内出现未被忽略的新文件（覆盖率、快照等测试产物）时仍判不通过，提示列出这些文件并建议加入 `.gitignore`。新文件位置检查也查改名后的新路径。
- 复审报告要有一处明确的结论：同一行“结论：……”，或单独一行“## 结论”后的第一个非空行；两种写法都按逗号、分号、句号、冒号拆成小句，整句恰好是“通过 / 不通过 / 未通过”（只认中文）的小句才算，“通过前需修复 H1”不算，结论词后带括号的（“通过（待 M2 修复后）”）也不算；登记 pass 要求结论是通过，登记 fail 要求结论是不通过，找不到、前后矛盾或不符时拒绝。
- 默认主干的识别：`base` 显式写成本地分支名（如 `main`）、或远端不叫 `origin` 时，本地分支会被当作主干，能改本地分支的人就能改判定依据；建议把 `base` 指向远端跟踪分支（如 `origin/main`）。
- `git push --all` 这类一次推多个分支的推送，只要有一个分支不是当前 HEAD 且不在基准分支里就整体拒绝，请逐个分支检出后推送。
- `pre-push` 流程的树哈希不含 `reviewIgnore` 之内的文档：只改文档的改动每一轮树哈希都相同，推送也不要求记录。这类改动的复审登记靠记录里的分支、HEAD 提交号和文档内容哈希对应到具体提交。复审轮次按工作树和分支名分开计。一轮是登记过不通过的一份被审内容：`pr` 流程是 PR 的一个最终提交；`pre-push` 流程是登记时的工作区内容，按树哈希加文档内容哈希区分，不按 HEAD 提交号（修复留在工作区不提交时 HEAD 不变；reset 回已经计入的旧提交时，HEAD 就是那个已计入的提交；两种情况按提交号计都会被当成已计入而放行，所以改按内容计）；同一份内容上两种审查都不通过只算一轮。满上限后对新内容的登记、以及在已计入的内容上重登同一种审查，都要 `--user-decision`；只有在已计入的内容上首次登记另一种审查不拦。其余计数细节：换一个工作树、或给分支改名，轮次从零算起；重用一个旧分支名，会把以前那个分支的登记算进来；登记时有未提交的改动会在输出和记录里写明。历史在 git 目录下的 `engineering-gate/reviews/log.jsonl`，报告副本在同目录的 `branches/<分支>/` 下。
- 巡检的阶段内登记只认三种写法：阶段 README 表格第一列整格的文件名、反引号里的名字、链接目标；子目录里的文件登记相对该阶段目录的路径或所在目录名，只写文件名不算。记录目录、以点开头的文件、README 自己不查。
- 默认的复审者名单（0.5.0 起含 `product-dev:code-reviewer`）只在首次创建项目配置时写入；已安装项目的名单不随升级改变，同步时给出升级提示，要用新名字须手动加，且要合入主干后才生效（复审者名单是判定策略字段）。
- 闸门脚本本身（`scripts/engineering/gate/`）被分支改动时，本地闸门的结果不可信：由复审者核对脚本改动本身，有 CI 的项目另看 CI；没有 CI 的项目没有这道外部核对，只剩复审者核对脚本差异，套件不另加拦截。
- 复审记录是本机约定，不是密码学证明；复审者名字由登记者填写，套件不验证它确是独立子代理。守住它靠 PR 里公开的复审摘要。
- 测试记录与 `pre-push` 流程的复审记录放在各工作树自己的 git 目录（`engineering-gate/`），多个工作树互不覆盖，不进工作区；闸门锁与 `pr` 流程的 PR 审查记录（`engineering-gate/pr/<编号>/`）放在 git 公共目录，所有工作树共用：同一仓库同时只跑一个闸门，复审与合并可以在不同工作树进行。
- `pr` 流程只支持 GitHub（经 `gh`）；`gh` 不存在或调用失败时登记与合并都报错，不放行。只改文档的 PR 和各风险档位怎样审，见 `references/process.md` 第 4 节。
- 记录类目录（`hygiene.recordDirs`，如 `docs/adr`、`docs/acceptance`、`docs/release`）里已跟踪的文件被修改、删除或改名，巡检都报错：改名按旧路径删除计，工作区和相对基准分支已提交的改动都查；分支上新增后又删掉、从未进过基准的不报。
- 同步比较闸门与钩子脚本、`.claude/settings.json` 和锁文件时只比内容、不计换行风格（AGENTS.md 规则块仍按原文比较）：项目开着 `core.autocrlf` 而 `.gitattributes` 没写 `eol=lf` 时，检出成 CRLF 的套件文件不算本地修改，漂移检查也不报；只差换行的 `.claude/settings.json` 与锁文件不重写。仍建议在 `.gitattributes` 里写 `* text=auto eol=lf`。
- 巡检的“已合并分支”判断基于补丁等价（git cherry），squash 合并后的分支需人工复核。

## 7. 维护

- 源目录是源仓库（ac0033/product-dev）的 `components/engineering-kit/`；本机若另有生效副本（如 Claude Code 的技能目录），改动后把源目录复制过去，保持一致。
- 验证：`cd "<kit>" && node --test tests/*.test.mjs`（changeset 测试在临时副本上运行）。
- 版本：`bundle.json` 的 `bundleVersion` 与 `kit/VERSION` 必须一致。发布前运行 `release.mjs --check`。
- 已有自己闸门的项目不要直接运行同步；迁移前先比对两边规则，具体项目的情况记在本机的 `references/*.local.md`。
