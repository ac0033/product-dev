# Product Dev · DeepSeek Harness 插件

把 [Product Dev](https://github.com/ac0033/product-dev) 的产品开发能力装进 DeepSeek Harness（DSH）：从零做产品、给现有项目加功能、修 bug，也能单独推进设计、文档修改、复审、验收或工程套件维护。

通过 `/product-dev` 一个入口，按任务调用随包提供的三组能力：

- **产品设计**：需求梳理与 PRD、可操作原型与界面设计、架构与图表。
- **工程实现**：代码探索、方案对比、任务拆解、开发测试与调试。
- **质量与交付**：工程规则与检查闸门、独立审查、PR 与合并、验收与获授权的发布。

各阶段保留产物与验证证据，帮助你减少遗漏、反复解释和交接断层。沿用项目规则与授权边界；实际执行依赖 DSH 提供的终端、浏览器和子代理等工具，见[宿主能力说明](https://github.com/ac0033/product-dev/blob/main/INSTALL.md#宿主能力与工程套件)。

## 安装

在 DSH 网页版或桌面版打开 **Plugins → Add plugin**，输入包名加版本号，然后点 **Install** 并启用。

```text
dsh-product-dev@0.2.5
```

使用 `dsh` 命令行时运行下面的命令。

```bash
dsh plugin --profile web add dsh-product-dev@0.2.5
```

## 使用

在目标项目里开始对话，输入 `/product-dev` 加上你的任务，或直接描述产品想法、功能需求或 bug，由模型加载入口技能。

## 包里有什么

- `skills/product-dev/`：入口技能和它依赖的全部资料，与其他 Agent 使用的技能包内容相同。
- `lib/index.js`：向 DSH 注册上面这个技能目录。不联网，不读写包目录以外的文件。

你在项目的 `.dsh/skills/`、`.agents/skills/` 或用户目录里放了同名的 `product-dev` 技能时，DSH 优先使用你的那一份。

## 许可

自有内容以 MIT 发布。包内的第三方内容保留原许可，见 `THIRD_PARTY_NOTICES.md`。
