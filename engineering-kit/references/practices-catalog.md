# 可复用工程实践目录

说明：本文件保留盘点时的历史结论；经验记录的现行规则见 `process.md` 的“经验记录”节。

来源：LearnMap（D:\4_Projects\LearnMap）的 AGENTS.md、docs/engineering/（playbook、code-gate、git、sessions、development）、scripts/dev/（gate、hooks、merge）、memory 与 practices/。盘点日期 2026-11-04。

通用度：★ 任何项目都适用；◇ 机制通用，参数或语言需按项目适配；● 项目特定，只作参考。

## 一、推荐形态（不是三选一，按“谁来执行”分层）

| 层 | 放什么 | 推荐形态 | 理由 |
|---|---|---|---|
| L1 原则 | 不可协商的纪律，约 20 条 | 全局 CLAUDE.md 新增一节“工程纪律”（prompt 形式） | 每次会话都要生效，必须短 |
| L2 流程与判断 | 开发→复审→PR→合并、授权分级、续做核对、证据包、会话分工 | skill（扩展现有 dev-flow，新增项目接入 skill） | 按需加载，可附模板与检查清单 |
| L3 机械执行 | 测试先行、注释检查、复审记录、推送闸门、合并闸门、豁免、全机锁、钩子 | 可执行脚手架 engineering-kit（脚本 + gate.config.json + 钩子模板） | prompt 无法强制，只能靠脚本与钩子 |
| L4 领域参考 | 分层评审漏斗、配额与非高峰、信源核对、演示库隔离、Windows 环境坑 | 各 skill 的 references/ 子文件 | 只在相关项目加载，不占常驻上下文 |

分发：复用已有的 `ac0033/skills` 仓库（已有 `synchronous` 同步 skill 与 submodule 机制）。kit 放在该仓库的 `engineering-kit/`，目标项目用同步脚本复制，并在项目里记录版本（如 `.engineering-kit.lock`），以后按版本升级。稳定后可再包装为 Claude Code 插件（hooks + skills + code-reviewer 子代理定义），`/plugin install` 一键安装。

关键取舍：强制力放在 git pre-push 钩子，而不只靠 Claude Code 的 PreToolUse 钩子。LearnMap 的 code-gate.md 第 4 节自己承认：用户在终端直接 `git push` 不经过 Claude 钩子。挂到 git 钩子后既堵住这个口子，也对 Codex 等其他 agent 生效。

## 二、抽象清单

### A. 纪律与交付判断（L1 为主）

| 编号 | 实践（一句话原则） | LearnMap 来源 | 通用度 | 载体 |
|---|---|---|---|---|
| A1 | 只有达标与未达标：不以“难”降标准；做不到先调研替代方法，确实不行则如实列出交用户决定，不自行降级或改为人工了事 | AGENTS.md 根本原则；memory feedback-no-lowered-standards | ★ | L1 |
| A2 | 不把技术建议说成用户已决定；未知的供应商、费用、凭据不虚记为确定 | playbook 3.2；AGENTS 工作方式 | ★ | L1 |
| A3 | 先确认再动手：影响行为、权限、费用的先问；无风险的实现细节自行决定并列出 | playbook 3.2 | ★ | L1 |
| A4 | 完成分状态，每态有证据且不能互相替代（实现 / CI 通过 / 验收 / 已上线）；“脚本返回 0”不算业务成功 | playbook 0.2 | ★ | L1 |
| A5 | 汇报先说是否可交付与剩余阻塞，再给证据；区分工程检查、用户验收、可发布、已发布；失败不写“通过” | AGENTS 工作方式 | ★ | L1（全局 CLAUDE.md 汇报格式已覆盖一部分，不重复） |
| A6 | 续做前核对实际进展（git log、开着的 PR、运行日志），不沿用上次的检查结果 | AGENTS 工作方式；playbook 12 | ★ | L1 |
| A7 | 批量改数据、删文件、大范围重构前先留可恢复快照（commit 或备份） | playbook 12 | ★ | L1 |
| A8 | 同类文档只留一份最终版，直接替换不并存；过时文件删除，git 历史即备份 | playbook 1；memory single-source-docs | ★ | L1 |
| A9 | 分支从最新主干建；一任务一分支一 PR；合并后删远端与本地分支、清理工作树，汇报完成前核对 | git.md；全局 CLAUDE.md | ★ | L1 + L2 |
| A10 | 对话范围控制：核心任务完成后发现的其他事写进待办，不顺手执行 | 全局 CLAUDE.md（已有） | ★ | 已在全局，不重复 |

### B. 授权与风险（L1 + L2）

| 编号 | 实践 | 来源 | 通用度 | 载体 |
|---|---|---|---|---|
| B1 | 操作列表式授权：每类操作标“可以 / 需授权 / 高风险单独授权”，已授权的不重复问 | playbook 2.2 | ★ | L2（模板表格） |
| B2 | 风险按影响范围与可恢复性分级，不按改动行数；中高风险要先出方案、写契约、加强复审 | playbook 2.3 | ★ | L2 |
| B3 | 长期预授权的前提：闸门能自动拦住问题、核对不过不执行；回滚、数据恢复、破坏性迁移、密钥、系统配置仍逐次授权；授权原话记入记忆 | playbook 2.2；memory standing-release-authorization | ◇ | 模板中做成可选项，由用户决定是否启用 |
| B4 | 发版只由一个指定的对话执行，其他会话只合并 PR 并通知发版负责人 | memory release-only-from-main-session | ◇（多会话项目） | L2 |
| B5 | 上线分流：影响体验、使用、大中问题上线前修；其余进“上线后修复清单”另开对话修。清单是排期，流程一个不省 | code-gate 第 6 节；memory ship-first-server-only | ★ | L1（一句）+ L2（判定规则） |

### C. 开发闸门（L3 机械执行）

| 编号 | 实践 | 来源（文件） | 通用度 | 载体 |
|---|---|---|---|---|
| C1 | 测试先行：改源文件必须有引用它的测试，且测试随改动一起改；由 import 图机械检查 | check-test-first.mjs；code-gate 第 1、3 节 | ◇（import 解析按语言适配） | L3 |
| C2 | 注释：文件头 + 导出符号注释，只检查本次改动的声明行；存量用 `--all` 盘点 | check-comments.mjs | ◇ | L3 |
| C3 | 独立复审：复审者是独立子代理，不带作者结论；报告必须含“结论”；记录绑定代码工作树哈希，改代码即作废，只改文档不作废 | record-review.mjs；lib.mjs 的 workTreeHash | ★ | L3 |
| C4 | 复审严重度分流：写代码者和主对话不能自行改评级；中级降级必须写依据 | code-gate 第 6 节 | ★ | L2 规则 + L3 记录字段 |
| C5 | 一致性审：只审本次增量的矛盾、重复、过时；任务书模板；定期全量清理 | code-gate 第 6a 节；features/consistency-review.md | ◇ | L2（任务书模板）+ 机械部分进 L3 |
| C6 | 推送闸门：推送前核对测试记录和复审记录与当前树一致；直接合并命令一律拒绝 | pre-bash.mjs；verify.mjs | ★ | L3（改挂 git pre-push） |
| C7 | 合并闸门：唯一合并入口脚本；等汇总检查项出现并结束；全部通过才合并；落后主干则更新后重等；合并与判定在共用锁内执行 | merge-when-green.sh；merge-check.mjs | ◇（依赖 GitHub CLI） | L3 |
| C8 | 豁免入库、必须写理由、复审逐条核对；“先豁免以后补”不接受 | exempt.json | ★ | L3 |
| C9 | 相关测试选择：按 import 图只跑受影响的数据库测试；配置一份“拿不准就跑全量”的文件清单 | related-tests.mjs | ◇ | L3 |
| C10 | 全机同时只跑一个重负载闸门（锁，超时自动清理）；并行会话各用独立工作树与测试库，库名带工作树名便于清理 | gate-lock.mjs；code-gate 第 2b 节 | ★ | L3 |
| C11 | 测试库安全：只连 `*_test` / `*_ci` 库，库名与主机双重校验；测试数据只用合成或演示数据 | run-tests.mjs | ★ | L3 |
| C12 | 本机快检、云端全量：本机跑静态、单元与相关集成，全量与端到端交 CI；云端额度用尽再本机补跑 | sessions.md 第 4 节 | ◇ | L2 |
| C13 | 钩子分级：写文件后即时提醒、不回滚；推送前硬拦；解析命令时跳过引号与 heredoc 内容以减少误伤 | post-edit.mjs；pre-bash.mjs | ★ | L3 |
| C14 | 豁免与跳过集成测试只能由用户决定；跳过记录写进闸门结果，推送时单独提示 | code-gate 第 4 节 | ★ | L3 |

### D. 发布与运行（L2 + L3，机制通用、参数多为项目特定）

| 编号 | 实践 | 来源 | 通用度 | 载体 |
|---|---|---|---|---|
| D1 | 构建一次，多环境使用同一制品；发布记录绑定制品 ID（镜像 ID 而非标签）；验收后制品或数据库版本变化则验收失效 | playbook 5、8.1 | ◇（有制品的项目） | L2 + L3 |
| D2 | 只有主干能产出发布制品；服务器不直接改代码 | playbook 5 | ★ | L1 |
| D3 | 发布门禁脚本自动核对：验收记录与运行版本一致；发布前备份并校验可读；发布与回滚互斥 | promote.sh（deploy/server） | ◇ | L3 |
| D4 | 数据库迁移只向前、带校验和、带咨询锁；结构变更 Expand → Migrate → Contract；上一版须能在新库上运行 | playbook 7 | ◇（有数据库的项目） | L2 |
| D5 | 健康检查分级告警（critical / warning），同一问题限频；告警通道要定期手动验证 | playbook 9 | ◇ | L3 |
| D6 | 发布记录按时间倒序顶部追加：版本、制品、验证结果、未完成项 | docs/release/readiness.md | ★ | L2 模板 |
| D7 | 证据包固定结构（功能、PR、CI、审查、上线后修复清单、数据库与配置、制品、预发、人工验收、授权、切换、复查、回滚、限制）；没有的项写“无”不留空；“计划执行”不写成“已执行” | playbook 13 | ★ | L2 模板 |
| D8 | 固定板块逐项同步检查：每次发版逐项判断是否需要更新，不需要的写明理由，不能只确认页面返回 200 | playbook 6.3 | ◇（有固定对外页面的项目） | L2 清单模板 |
| D9 | 部署避开定时任务窗口（先看服务器时间） | memory deploy-avoid-daily-window | ● | 项目记录，不进 kit |

### E. 多会话与模型（L2）

| 编号 | 实践 | 来源 | 通用度 | 载体 |
|---|---|---|---|---|
| E1 | 主对话（统筹、合并、部署、汇报）与开发会话（按主题，最多 3 个）分工；开发会话不合并、不部署 | sessions.md 第 1 节 | ◇（多会话时） | L2 |
| E2 | 模型分级：高风险与统筹用最强模型，一般开发用中档，纯执行用轻量；复审模型不弱于作者；进行中的会话不中途换模型 | sessions.md 第 2 节 | ★（具体型号随版本更新） | L2 |
| E3 | 按主题开会话，不按 PR 开；上下文过半或连续 2–3 个 PR 时写交接要点、换会话接续 | sessions.md 第 1 节 | ★ | L2 |
| E4 | 任务书只写增量，通用规则写一次并引用；日志只进文件，只读摘要；消息只在节点发 | sessions.md 第 6 节 | ★ | L2 |
| E5 | 合并集中在窗口里，部署与验收每批一次 | sessions.md 第 5 节 | ◇ | L2 |
| E6 | 子代理结果由主对话核对后才算完成；完成即归档，不长期挂着 | 全局 CLAUDE.md（已有） | ★ | 已在全局 |

### F. 需求与交付（L2）

| 编号 | 实践 | 来源 | 通用度 | 载体 |
|---|---|---|---|---|
| F1 | 中高风险先澄清需求与方案，再写功能契约；契约定义“怎样证明正确”，已批准的验收条件不得擅自弱化 | playbook 3.1–3.2；features/README | ★ | L2 模板 |
| F2 | 实现中自行确定的口径单列，待用户确认 | sessions.md 第 7 节 | ★ | L2 |
| F3 | 内容数据走“数据文件 + 幂等导入脚本 + PR”；合并后先在预发核对数量与抽样，再上生产 | playbook 11 | ◇ | L2 |
| F4 | PR 说明固定结构：功能概述、契约、主要变更、数据与配置影响、测试、风险与回滚、上线后修复清单 | playbook 4.1 | ★ | L2 模板 |

### G. 人机交互与确认（L1 + L2）

| 编号 | 实践 | 来源 | 通用度 | 载体 |
|---|---|---|---|---|
| G1 | 待决事项集中用交互式提问一次问完，推荐项放第一 | memory feedback-interactive-questions | ★ | L1 |
| G2 | 所有确认列表同时支持单条与批量；批量前预览；每批有批次号可整批撤销；高风险条目只允许单条 | practices/workflow.md | ◇（有界面的项目） | L2 |
| G3 | 模型产出的规则、阈值、数据源改动：建议 → 用户接受 → 生效并记版本 → 可回退；未处理的建议下期标为“已被取代” | practices/workflow.md；memory owner-batch-and-approval | ◇（有自动模型任务的项目） | L2 |
| G4 | 汇报附“待我确认”队列长度 | memory | ● | 项目记录 |

### H. AI 产品与数据（L4 参考，项目特定）

| 编号 | 实践 | 来源 | 通用度 | 载体 |
|---|---|---|---|---|
| H1 | 分层评审漏斗：便宜的全量粗判 → 深判只针对关键或有分歧的少数 → 仲裁 → 人工限量 | practices/workflow.md | ◇ | L4 reference |
| H2 | 成本与配额：每日调用上限、月成本预算；日常定时任务避峰，一次性验证直接跑 | memory model-cost-offpeak；practices | ◇ | L4 reference |
| H3 | 公开与私有出口隔离：所有公开出口共用只读层，个人数据不进任何公开出口；演示数据带标记并与真实库隔离 | AGENTS 业务规则 | ◇ | L4 reference |
| H4 | 信源四项核对：是否全部接入并采集、是否动态更新、是否应采尽采、时效与质量口径是否统一 | AGENTS 业务规则 | ● | 项目记录 |
| H5 | 访客或用户自带的模型配置只存浏览器、只在单次请求内存中转发，不落库不落日志 | AGENTS 业务规则 | ● | 项目记录 |

### I. 环境与工具（L4，个人环境）

| 编号 | 实践 | 来源 | 通用度 | 载体 |
|---|---|---|---|---|
| I1 | Windows + Git Bash 的坑：复杂 heredoc 改用文件；反斜杠会丢失；MSYS 改写 `/` 开头参数（设 MSYS_NO_PATHCONV）；TaskStop 留孤儿进程（用父进程链定位，不凭端口或命令名停进程）；PowerShell 5 的 .ps1 要存 BOM；tsc 需设堆上限 | memory feedback-windows-shell-pitfalls | ★（个人环境） | 全局 reference 文件 |
| I2 | 测试端口被占时换端口，不杀别人的进程；数据库被占用时先查 pg_stat_activity | code-gate 第 2b 节 | ◇ | L3 报错信息 + 文档 |
| I3 | 闸门运行期间不改文件、不 commit（会作废记录） | memory feedback-qa-release-session-pitfalls | ◇ | L2 注意事项 |
| I4 | Docker Desktop 退出会带走容器，恢复顺序（启动 Docker、起测试库、runner heal） | memory reference-docker-recovery | ● | 项目记录 |

### J. 记忆与经验（元层）

| 编号 | 实践 | 来源 | 通用度 | 载体 |
|---|---|---|---|---|
| J1 | 记忆一条一事实，带 type；MEMORY.md 只放索引；同一件事更新原文件而不新建 | 全局 memory 规则 | ★ | 已在全局 |
| J2 | practices/ 只记可迁移的原则与方法，不记只属于某项目的结论 | practices/README.md；全局 practice-log skill | ★ | 已有 practice-log |

## 三、与现有 skills 的对照（避免重复造轮子）

- **dev-flow**（ai_agent/skills）：已覆盖 B、C、F 的流程编排，但内容写死了 LearnMap 路径与契约。建议改为通用版，项目差异引用 kit 配置。
- **release-handoff**：对应 D 系列的发布交接。本次未逐条核对其内容，改动前需要先读一遍再决定是合并还是替换。
- **tidy-docs**：A8、规则文件精简与归档规则已覆盖。
- **practice-log**：J2 已覆盖。
- **synchronous**：就是分发工具，用它同步到 Claude Code、Codex 等。
- **submit / publish-private-project**：与 A9、发布相关的收尾动作可以复用，不属于本次抽象的核心。

## 四、建议落地顺序（先小后大，每步可单独验收）

1. **L1 原则一节**：把 A1–A9、B2、B5、G1 凝成约 25 行，放进全局 CLAUDE.md。这是最便宜、收益最大的一步，但改的是全局配置，需要你确认。
2. **engineering-kit（L3）**：从 scripts/dev/gate 与 scripts/dev/hooks 抽出 lib.mjs、gate-lock.mjs、record-review.mjs、verify.mjs、merge-when-green.sh、merge-check.mjs、两个钩子，并把路径与阈值挪进 gate.config.json；测试先行与注释检查做成按语言的适配器（首版只做 TypeScript/Node，其他语言先留接口）。现有这部分约 2300 行，大部分可直接复用。
3. **project-bootstrap skill（L2）**：对新项目或老项目一键套用，生成 AGENTS.md 骨架、docs/engineering 骨架、kit 脚本、钩子、git pre-push、practices/。
4. **dev-flow 通用化**：去掉 LearnMap 专有内容，引用 kit 与模板。
5. **试装验证**：挑一个其他项目试装，跑通一次完整闸门，才算可复用。
6. **可选**：稳定后包装为 Claude Code 插件。

## 五、风险与边界

- **不是所有项目都需要全部机制。** 多会话、工作树隔离、全机锁、发布互斥只在多人或多会话、有服务器时才有意义。kit 要做成可开关的配置，而不是全量照搬。
- **“三个项目都用到才抽成 kit”。** 当前只有 LearnMap 一个样本，kit 的接口很可能还要改。L1 与 L2 可以先行，L3 等第二个项目用过再固化。
- **语言不通用。** 测试先行与注释检查依赖语法与 import 解析，换到 Python 或其他语言要重写适配器。需要先确认目标项目的语言分布。
- **复审是本机约定，不是密码学证明。** LearnMap 的文档已承认这一点，kit 也应如实写明，并靠 PR 中公开的复审摘要兜底。
- **强制力只能靠脚本与钩子。** 纯文字规则在不同 agent 之间一致性很差，这是 L3 存在的理由。
