## 工程流程（engineering-kit 管理，同步时只替换本块）

完整流程与细则：engineering-kit 技能的 `references/process.md`（按需读取）。

流程地图：
1. 开工：从最新主干新建分支；列出分支与工作树，确认没有遗留的未提交改动。
2. 方案：中高风险先澄清并取得确认，写功能契约（docs/_templates/feature-contract.md）。
3. 开发：测试先行；源文件要有业务注释；新顶层目录须在白名单内。
4. 闸门：`node scripts/engineering/gate/gate.mjs` 通过后，才做独立子代理复审。
5. 复审：`node scripts/engineering/gate/review.mjs pass --reviewer <名> --report <报告> --summary "<一句话>"`。
6. 推送：pre-push 钩子核对；合并只走项目约定的入口，并等 CI 全部通过。
7. 文档：活文档原地覆盖；记录类（ADR、验收证据包、发布记录）只追加。新文件须落在阶段或记录目录，并登记索引。
8. 收工：删分支、清工作树、检查新文件、更新索引、删临时文件；做经验提炼（用户的直接记录，agent 的待确认）。
9. 巡检：定期运行 `node scripts/engineering/gate/hygiene.mjs`；删除文件先列清单经用户确认。
10. 标准：只有达标与未达标。做不到先调研替代做法，确实不行则列出交用户决定，不降级。
