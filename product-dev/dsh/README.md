# Product Dev · DeepSeek Harness 插件

把 [Product Dev](https://github.com/ac0033/skills/tree/main/product-dev) 的产品开发工作流装进 DeepSeek Harness（DSH）。安装后技能目录里多一个 `product-dev` 入口。

## 安装

在 DSH 网页版或桌面版打开 **Plugins → Add plugin**，输入包名加版本号，然后点 **Install** 并启用。

```text
dsh-product-dev@0.2.3
```

使用 `dsh` 命令行时运行下面的命令。

```bash
dsh plugin --profile web add dsh-product-dev@0.2.3
```

## 使用

在目标项目里开始对话，输入 `/product-dev` 加上你的任务，或直接描述产品想法、功能需求或 bug，由模型加载入口技能。

## 包里有什么

- `skills/product-dev/`：入口技能和它依赖的全部资料，与其他 Agent 使用的技能包内容相同。
- `lib/index.js`：向 DSH 注册上面这个技能目录。不联网，不读写包目录以外的文件。

你在项目的 `.dsh/skills/`、`.agents/skills/` 或用户目录里放了同名的 `product-dev` 技能时，DSH 优先使用你的那一份。

## 许可

自有内容以 MIT 发布。包内的第三方内容保留原许可，见 `THIRD_PARTY_NOTICES.md`。
