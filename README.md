# ac0033 Skills

面向 Claude Code、Codex、DeepSeek Harness 和其他 Agent 的工具仓库。每个工具占一个顶层目录，说明、源码和测试都在自己的目录里。

## 工具

| 工具 | 用途 | 从哪里开始 |
| --- | --- | --- |
| [Product Dev](product-dev/README.md) | 产品开发插件：需求与 PRD、原型与界面、架构图表、开发测试、审查与交付；支持新项目、加功能、修 bug 和工程套件维护 | [快速开始](product-dev/README.md#快速开始) |

## 目录结构

```text
skills/
├── .claude-plugin/marketplace.json    Claude Code 插件市场清单，登记全部可安装的工具
├── .agents/plugins/marketplace.json   Codex 插件市场清单
├── .github/workflows/                 各工具的检查
├── product-dev/                       Product Dev 的全部内容
│   ├── plugin/                        插件成品，市场清单指向这里
│   ├── components/                    自有组件的源
│   ├── dsh/                           DeepSeek Harness 的 npm 包
│   ├── tools/  evals/  docs/          构建脚本、测试、图片
│   └── README.md  INSTALL.md  COMPONENTS.md
└── LICENSE
```

## 添加新工具

1. 在仓库根新建一个以工具名命名的目录，说明、源码、构建脚本和测试都放在里面，不往仓库根和其他工具的目录里放文件。
2. 工具是可安装的插件时，在两份市场清单里各加一项，`source` 指向工具目录里的插件成品。
3. 在 `.github/workflows/` 里加上这个工具的检查命令。
4. 在上面的工具表里加一行。

## 许可

仓库自有内容以 [MIT](LICENSE) 发布。各工具收录的第三方内容保留原许可，见工具目录里的第三方声明。
