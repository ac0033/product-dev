# 在其他 Agent 中使用 Product Dev

Product Dev 也提供一个可独立导入的 **Agent Skills 包**。整个包只注册 `product-dev` 入口，工作流需要的内部技能、子代理任务书、工程脚本和模板都在包里。不同宿主可以使用同一个包。

[下载 Product Dev 技能包](https://github.com/ac0033/product-dev/releases/download/v0.3.1/product-dev-skill.zip)

<a id="agent-install"></a>

## 给 Agent 的安装步骤

这一节写给替用户安装的 Agent。按顺序做，每一步以命令的实际输出为准。

1. **确认宿主。** 你运行在哪个 Agent 里，就装到哪个。判断不了时问用户，不要每个宿主都装一遍。
2. **查是否已装。** 先运行下表的验证命令。已经装过的不重复安装，直接做第 4 步；要更新时用 [README 的升级一节](https://github.com/ac0033/product-dev/blob/main/README.md#upgrade)里的命令。
3. **安装并验证。** 只用下表的来源。添加市场或安装时提示已存在的，以验证命令的结果为准，不算失败。其余命令失败时把命令和输出原样告诉用户，不换别的来源，也不手工复制文件代替。

   | 宿主 | 安装 | 验证 |
   | --- | --- | --- |
   | Claude Code | `claude plugin marketplace add ac0033/skills`，再 `claude plugin install product-dev@ac0033-skills` | `claude plugin list` 列出 `product-dev@ac0033-skills`，它下面的 `Status` 一行是 enabled |
   | Codex | `codex plugin marketplace add ac0033/skills`，再 `codex plugin add product-dev@ac0033-skills` | `codex plugin list` 里 `product-dev@ac0033-skills` 一行的状态是 `installed, enabled`；`not installed` 不算 |
   | DeepSeek Harness | 下文 DeepSeek Harness 一节的 `dsh plugin` 命令，或在 **Plugins → Add plugin** 里添加 | **Plugins** 页面里有 `dsh-product-dev` 且已启用；你看不到这个页面时，请用户确认 |
   | OpenCode、pi、WorkBuddy 等其他 Agent | 下载本页顶部的技能包，按下文对应宿主一节放到技能目录，保留包内全部文件 | 技能目录第一层有 `product-dev/SKILL.md`，宿主的技能列表里有 `product-dev` |

4. **核对版本。** 验证命令显示的版本号，应与[最新发布](https://github.com/ac0033/product-dev/releases/latest)的版本一致。不一致时按第 2 步链接里的升级命令更新一次，仍不一致就如实告诉用户。
5. **让它生效。** 安装前已经打开的会话看不到新插件。Claude Code 运行 `/reload-plugins` 或重新启动，Codex 重启桌面端或新开会话，其他宿主新开会话。
6. **向用户交代结果。** 说明装到了哪个宿主、版本号、怎样调用（Claude Code 是 `/product-dev:product-dev`，Codex 在技能列表里选 `product-dev`，DeepSeek Harness 是 `/product-dev`），以及哪一步没有做成。

安装只装插件本身，不向用户的项目写入任何文件。把工程套件同步进某个项目是另一件事，要用户另行同意。

## 按宿主安装

<a id="deepseek-harness"></a>

### DeepSeek Harness

推荐安装 npm 包 `dsh-product-dev`，不需要下载 ZIP。在 **Plugins → Add plugin** 输入 `dsh-product-dev@0.3.1`，或在终端运行下面的命令，然后启用插件。

```bash
dsh plugin --profile web add dsh-product-dev@0.3.1
```

不想装插件时，解压 ZIP，将整个 `product-dev` 文件夹放到项目的 `.dsh/skills/`，或放到用户目录的 `~/.dsh/skills/`。DSH 只识别技能目录下第一层的 `product-dev/SKILL.md`，不要再套一层文件夹。两种方式都在输入框用 `/product-dev` 加任务来调用。

[DeepSeek Harness 技能说明](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/skills.md)

### WorkBuddy

在「技能」页面选择「添加技能 → 上传技能」，导入下载的 `product-dev-skill.zip`。按提示完成检查和安装，然后在任务中选择 `product-dev`。使用本地开发流程时，在能读取目标项目、运行本地命令的工作环境里打开任务。

[WorkBuddy 技能说明](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market)

### pi

解压 ZIP，将整个 `product-dev` 文件夹放到项目的 `.pi/skills/`，或放到用户目录的 `~/.pi/agent/skills/` 供多个项目使用。打开项目后，在 pi 输入 `/skill:product-dev` 加上你的任务。

临时试用也可以从目标项目目录执行 `pi --skill /path/to/product-dev`，无需复制到默认扫描目录。

[pi 技能说明](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)

### OpenCode

解压 ZIP，将整个 `product-dev` 文件夹放到项目的 `.opencode/skills/`，或放到用户目录的 `~/.config/opencode/skills/`。打开项目后告诉 OpenCode「加载 `product-dev` 技能，先梳理这个功能的需求和验收标准」。它通过内置 `skill` 工具加载入口。

[OpenCode 技能说明](https://opencode.ai/docs/skills)

### 其他支持 Agent Skills 的宿主

把解压后的整个 `product-dev` 目录放到宿主支持的技能目录。若宿主支持项目级 `.agents/skills/`，可使用 `.agents/skills/product-dev/`。若宿主没有技能注册机制，可以让它直接读取解压后 `product-dev/SKILL.md`，再按相对路径读取包内资源。

单独复制 `SKILL.md` 会缺少工作流、脚本和模板。建议保留包里的目录结构。

[Agent Skills 格式规范](https://agentskills.io/specification)

## 宿主能力与工程套件

- 需求、方案和评审文档依赖读取项目文件。要改代码、运行测试或安装工程套件，还需要文件写入、终端以及项目所用工具。
- 浏览器走查、独立复审等步骤需要宿主提供相应工具或独立上下文。缺少工具时，按[完整工作流](plugin/skills/product-dev/SKILL.md)里的替代方式交接，并标明尚未完成的验证。
- `engineering-kit` 随包提供，Product Dev 可以读取规则、调用随附脚本。项目要使用套件的 Git 钩子、测试闸门和文档模板时，仍需按[工程套件说明](plugin/skills/engineering-kit/SKILL.md)把它们同步进项目。已有自己的检查机制时沿用项目规则。

便携包里的构建锁记录原生插件的来源和构建结果。便携包会将内部技能文件改名为 `WORKFLOW.md`，供入口按路径加载。

## 从源码生成

在已检出的仓库根目录使用 Node.js 24 运行下面的命令。输出目录名为 `product-dev`，使用一个尚不存在的目录。

```bash
node tools/build-portable-skill.mjs ./dist/product-dev
```

将整个输出目录放到宿主技能目录。需要 ZIP 时，压缩 `product-dev` 文件夹，让 ZIP 解压后得到 `product-dev/SKILL.md` 和同级的 `references/`。

DeepSeek Harness 的 npm 包用下面的命令装配，输出目录就是执行 `npm publish` 的目录。

```bash
node tools/build-dsh-package.mjs ./dist/dsh-product-dev
```
