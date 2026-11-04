# 试装记录：PDFtranslator（2026-11-04）

目的：验证工程闸门套件能否一键装进一个真实的 Python 项目，并且试装可以完全回退。

## 做法

- 没有直接改动原项目（它有他人未提交的改动，且 `.git/hooks` 是每个仓库独立的）。把 `.git` 整体复制到临时目录，在副本上 `reset --hard` 到已提交状态，并把 `origin` 指向本地裸仓库，避免误推到 GitHub。
- 试装分支 `trial/engineering-kit`，套件装入后提交为 `chore: install engineering kit`。
- 试装配置：`sourceGlobs` = `src/**/*.py`，`testGlobs` = `tests/**/*.py`，`commentMode` = `header`，`reviewIgnore` = `**/*.md`、`docs/**`，`testEnv` = `{PYTHONPATH: src}`，`testCommand` = 项目 `.venv` 的 pytest，只跑 `tests/test_layout_review.py`。
- 回退：删除副本与裸仓库，原项目用快照（HEAD、分支、`git status`、差异哈希、改动文件哈希、`.claude`、`.git/hooks`）比对，结果完全一致。

## 试装中验证到的

- 静态检查：新源文件无测试引用时拒绝（静态阶段就拦下，不跑测试）。
- 测试先行：只改测试、实现未写时测试失败，闸门记录 `passed=false`；补实现后通过。
- 复审记录：由独立子代理（`feature-dev:code-reviewer`）复审；报告格式、结论、允许名单都生效。
- 推送：真实 `git push` 经 pre-push 钩子核对通过并推送；范围内有未提交改动时拒绝。
- Claude 钩子（用模拟输入）：`gh pr merge`、`gh -R … pr merge`、`gh api …/merge` 拒绝；`git push`、`git --git-dir=… push` 先核对。

## 试装中发现并修复的套件缺陷

1. 测试命令需要环境变量（Python 的 `PYTHONPATH`）：新增 `testEnv`。
2. Python 的 `from 包 import 模块` 写法未被识别为测试引用：修正匹配。
3. 钩子把引号里的 `git push` 误判为推送（如 `grep "git push"`）：引号内容先剥离再判断，`bash -c "…"` 的载荷再分类。
4. 基准分支解析失败时静默放行：改为拒绝。
5. 推送核对用的是工作区，而推送的是提交：增加未提交改动检查（不用 pathspec，git 失败即拒绝）。
6. 闸门范围只看源文件，改闸门脚本或配置不要求记录：范围改为“非文档改动”。
7. 文件头判断漏算 Python 多行文档字符串：改为读取文件开头的连续注释或多行文档字符串。

## 已知上线后事项（未修，低级或试装局限）

- 全量测试套件在副本中无法收集：`tests/test_triage.py` 读取被 `.gitignore` 忽略的 `data/`，副本没有。试装只跑单文件；正式接入需在项目原目录跑全量。
- 解释器路径写死为原项目的 `.venv`（试装用）；正式接入应在项目内建环境并使用相对路径。
- 引号内的 `gh pr merge` 文字会被误拦（merge 判断从严，在原始文本上匹配）。
- 空格分隔的长选项值（`--git-dir .git push`）与带引号的完整路径（`"C:\…\git.exe" push`）仍可能识别不到推送。钩子只防误操作，git pre-push 兜底。
- `git status`/`diff` 的路径未用 `-z`，含 `" -> "` 或末尾空格的文件名有极小的误切分风险。
- Python 的 `from 包 import 名` 按名字匹配，通用模块名（如 `config`）可能被同名导入误判为有测试。
- 文件头：带 `r"""`、`u"""` 前缀的文档字符串不被识别；shebang 与 coding 行可凑够字数。
- 锁只看目录修改时间，没有进程存活检查。
- 存量代码：试装时 88 个源文件中 25 个缺文件头、14 个没有测试引用（静态文本匹配）。这些只在被修改时才被闸门拦截。
- 复审报告的 reviewer 名字与结论由命令行自填，写代码的人可以自己出具报告（已知的设计限制，套件定位是防误操作）。
