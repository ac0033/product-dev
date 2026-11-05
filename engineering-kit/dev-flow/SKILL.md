---
name: dev-flow
description: 从需求明确到 CI 通过并合并的开发流程，按项目实际规则运行；需要时交接发布。
argument-hint: "[需求、功能契约 ID 或分支名]"
disable-model-invocation: true
---

# /dev-flow

这是兼容入口。处理 `$ARGUMENTS` 时读取 `../references/dev-flow.local.md` 的本机项目专用流程，并以当前用户授权和项目规则为准；通用工程流程见 `../references/process.md`。若专用文件不可用，读取通用流程和当前项目规则，不推断缺失的项目命令。
