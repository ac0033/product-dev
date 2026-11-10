## 工程流程（engineering-kit 管理，同步时只替换本块）

完整流程与细则：engineering-kit 技能的 `references/process.md`（按需读取）。

流程地图：
1. 开工：从最新主干新建分支；列出分支与工作树，确认没有遗留的未提交改动。定好执行位置与顺序：能在云端会话做的开发和测试放云端；创造性工作优先、排在用户在场时；全量测试等重复性工作攒成整块，在用户该做的事做完后集中跑，可分多轮（创造 → 重复 → 再创造）。排程不改变流程，步骤与标准一项不省。
2. 方案：中高风险先澄清并取得确认，写功能契约（docs/_templates/feature-contract.md）。
3. 开发：测试先行；源文件要有业务注释；新顶层目录须在白名单内。
4. 闸门：`node scripts/engineering/gate/gate.mjs` 通过后，才复审或推送。复审流程看 engineering.config.json 的 `modules.gate.reviewFlow`（`pre-push` 默认，或 `pr`）。
5. 复审（独立子代理）：`pre-push` 在推送前做，`node scripts/engineering/gate/review.mjs pass --reviewer <名> --report <报告> --summary "<一句话>"`；`pr` 在 CI 全部通过后对 PR 做代码复审和一致性审（只改文档的 PR 不审），同一命令加 `--pr <编号> --kind code|consistency`（可延期的一致性审用 `defer --pr <编号> --kind consistency --reason "<理由>"`）。
6. 推送与合并：pre-push 钩子核对推送；不得直接 `gh pr merge`。`pr` 流程只经 `node scripts/engineering/gate/merge.mjs <PR>` 合并；`pre-push` 流程走项目约定的入口，并等 CI 全部通过。
7. 文档：活文档原地覆盖；记录类（ADR、验收证据包、发布记录）只追加。新文件须落在阶段或记录目录，并登记索引。在项目根目录之外新建目录或文件，须先经用户批准。
8. 收工：删分支、清工作树、逐个检查本次新建的目录和文件（不必留下的清理掉）、更新索引、删临时文件；做经验提炼（用户的直接记录，agent 的待确认）。
9. 巡检：定期运行 `node scripts/engineering/gate/hygiene.mjs`；删除文件先列清单经用户确认。
10. 标准：只有达标与未达标。做不到先调研替代做法，确实不行则列出交用户决定，不降级。
