# Product Dev 独立仓库迁移

## 范围与行为契约

迁移源码、内部组件、插件、npm 包、便携包、文档、测试与 CI；不改变插件功能和调用入口。集合仓库只保留导航、双宿主市场和市场校验。身份保持 ac0033-skills / product-dev / dsh-product-dev。

## 历史与回退

保留原仓库 main 全部祖先与 Product Dev、engineering-kit 发布标签，原 SHA 不改写。工程套件详细历史由 engineering-kit-v0.1.0 至 engineering-kit-v0.4.0 标签保留；入口前身由 history/project-flow 标签保留。新根目录用普通迁移提交形成，未导入其他 Claude 会话 WIP 分支。

原主干：7723bb943fb1d01e7490320239b28b05463d8ab9；原 0.2.4：d4c214716c471d17761df3c4b7db54e7699b9299。更早的 e78609c 将顶层组件、tools、evals 和图片收进 product-dev，故不使用单目录 split。旧仓库所有 Release、标签和下载资产保持原位。

若市场切换失败，回退集合仓库的市场修改至 0.2.4 原路径，并回退源码删除提交；不删除新旧发行资产，不覆盖已发布 npm 版本。npm 若需修复发布下一补丁版本。

## 验收标准与证据

两仓库 CI 和独立双审通过；插件三个分发版本、许可、源码位置和资源链接一致；真实 Claude Code、Codex 和 DSH 分别在隔离配置验证 0.2.4 升级及全新安装；公开 npm、市场、GitHub 标签及资产回读一致；旧资产仍可下载。客户端验证完成前不删除集合仓库源码。最终 SHA、CI、审查和客户端输出记录在对应 PR 与 GitHub Release 中，未验证路径明确标记。
