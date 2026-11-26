# GEMINI.md

> **文档定位**：本文件为 Antigravity 的项目级上下文规则，总结 MeetMind 新版「数字人会议」的恢复方案与演进状态（来源：Codex 会话 `01a20ca2-e9e0-7f12-8b84-bf48605e7071` 及其 2026-11-24 ~ 11-25 续篇）。与 [AGENTS.md](./AGENTS.md) 中的旧版背景和编码规范互补；凡涉及新版架构、路由、账号与会话机制，以本文件与 [数字人会议使用与恢复手册.md](./docs/数字人会议使用与恢复手册.md) 为准。

## 一、新版核心架构与执行流

MeetMind 已从早期的「固定 5 角色 + 右侧问答助手」升级为「按每场会议实际参会成员动态建图的数字人协作系统」，每个注册用户与 5 个内置角色在会议中都作为独立的数字人图节点运行。

```text
主持人发送需求 → START → rewrite_node → intent_node → task_boundary_node
  ├─ direct（简单问答）     → 主持人的数字人直接回复 → teamRouter → END
  └─ task / everyone（协作）→ task_plan_node（生成父任务与有序子任务）
                                → 按计划进入数字人节点 → teamRouter
                                                            ├─ 还有未完成步骤 → 下一数字人节点
                                                            └─ 步骤全部完成   → END
```

- **单轮结束边界**：图中的 `END` 仅代表**当前这条需求对应的讨论轮次结束**，并非关闭整场会议。
- **整场结束边界**：会议期间可反复发起多轮需求；仅当会议处于空闲状态且主持人点击右下角「结束」按钮后，才关闭整场会议并生成会议纪要。

## 二、已确认的产品与权限规则

以下规则来自原始 10 条恢复需求及规划阶段的 5 轮交互确认：

1. **数字人账号与个人设置**
   - 每个用户在数据库注册后即拥有一个对应的数字人，记录名称、简介、个人记忆、可用工具列表、可用 Skills 列表与个人知识库。
   - 登录后点击左下角账号菜单进入「设置」，统一管理数字人名称、简介、个人记忆（原独立入口已合并至此）、工具、Skills 及知识库文件上传。
   - 知识库复用现有 PostgreSQL 混合检索（`pgvector` + `pg_trgm`）与本地 cross-encoder 重排，支持 TXT、Markdown、JSON、PDF、DOCX，单文件上限 `10 MiB`；上传后展示文件名与文本块数。飞书知识接入暂列为后续项。

2. **五个内置角色账号**
   - 保留 `architect`（架构师）、`frontend`（前端）、`backend`（后端）、`tester`（测试）、`pm`（产品经理）的既有提示词和知识库，同时初始化为独立账号，在新建会议时始终可选。
   - 需用内置角色账号登录时，在根目录 `.env` 配置对应的 `MEETMIND_<ROLE>_PASSWORD`（如 `MEETMIND_ARCHITECT_PASSWORD`）并重启 runtime；未配密码时仍可被选入会议参会。
   - 全局模型设置由 `admin` 账号管理；默认演示密码仅限本机访问，非本机或部署环境须在 `.env` 配置 `MEETMIND_ADMIN_PASSWORD` 并重启后端。

3. **会议成员权限与实时隔离**
   - 点击「+ 新会话」可从数据库现有用户（包含 5 个内置角色和注册用户）中选择参会成员，创建后参会名单固定。
   - 发起人为**主持人**，其他参会人为**参与者**：只有主持人可以发送真人消息、审批高风险工具、归档或结束会议；参与者登录后可在会话列表看到该会议，并以只读模式查看实时讨论、历史消息、任务计划与纪要。
   - 后端基于登录凭据统一校验 JSON-RPC 与 SSE 的成员权限；前端登录后复用一条 SSE 连接，按 `sessionId` 将事件分发到对应会话；工具审批请求仅推送给主持人。

4. **直接回复与任务规划规则**
   - `task_boundary_node` 判断本轮需求是否需要规划：
     - 简单问答（如「你好，你是谁？」）走 `direct` 分支，不生成多步任务规划，直接由**主持人的数字人**回复。
     - 协作任务（如「每个人说一个 1」「分析一下项目」）进入 `task_plan_node`，先生成父任务和有序子任务列表并落库，再按序交由对应数字人节点执行。
   - **全员任务（`everyone`）范围**：包含**主持人的数字人**和所有选中的参会成员，每人分配一步。
   - **非全员任务**：取消旧版固定由某角色开场或收尾的约定，主持人的数字人仅在被任务计划分配步骤时才发言。
   - 每次主持人发言对应一个独立轮次（requirement）及关联计划，在右上角「任务计划」面板可查看当前与历史轮次的父任务、子任务顺序与执行进度。

5. **个人资料隔离**
   - 数字人被选入他人发起的会议时，默认按自己的个人配置使用自身记忆、已启用的 RAG 知识库、工具和 Skills。
   - 会议中仅共享数字人生成的回复内容与工具名称，不向其他参会人暴露原始个人记忆与 RAG 检索原文。

6. **会话保留与归档**
   - 后续所有会议记录严格持久化保存；左侧原有「删除会话」操作改为「归档」。
   - 会议归档后从常用列表移出，但可从「归档会话」重新打开，完整查看历史消息、任务计划与会议纪要。

7. **结束会议与纪要生成**
   - 会议空闲时，主持人点击右下角「结束」：后端先把数据库中的会议状态更新为「已结束」并锁定发言，再读取按顺序保存的全量原始消息调用大模型总结（长会议分段总结并滚动合并草稿）。
   - 纪要默认写入 `data/summary/`，文件名固定为 `YYYY-MM-DD_HH-mm-ss_<sessionId>.md`（以会议创建时间开头），正文首行展示按 `Asia/Ho_Chi_Minh` 时区格式化的会议起止时间。
   - 纪要生成失败时会议仍保持「已结束」，主持人可点击顶部「重试纪要」并复用同一输出路径；参与者可通过右上角「会议纪要」查看正文或下载 Markdown。

## 三、核心代码与数据表定位

### 后端（`apps/runtime`）

- **LangGraph 编排**：[meetingGraph.ts](./apps/runtime/src/graph/meetingGraph.ts)（包含 `classifyMeetingRule`、`teamRouter`、`buildMeetingGraph`，按会议实际参会数字人注册节点，由 `teamRouter` 根据已完成步数驱动下一节点）。
- **数字人节点执行**：[twinAgent.ts](./apps/runtime/src/agents/twinAgent.ts)（`TwinAgent`）与 [capabilities.ts](./apps/runtime/src/tools/capabilities.ts)（按账号/配置校验可用工具与 Skills；源码检索限定目录，写/改文件、读进程列表及直接抓 URL 仅在管理员主持且由其数字人调用时开放）。
- **数字人表与鉴权**：[twins.ts](./apps/runtime/src/database/users/twins.ts)（`ensureTwinTables` 维护用户数字人资料、能力列表与登录态校验）。
- **会议、轮次与计划表**：[meetingStore.ts](./apps/runtime/src/database/chat/meetingStore.ts)（`ensureMeetingTables`：`sessions` 记录主持人、参会成员、会议状态、归档时间与纪要进度/文件名；`meeting_rounds` 记录需求与轮次状态；`task_plans` 记录父任务与有序子任务；`messages` 关联轮次与步骤索引以保证断点恢复幂等）。
- **RPC、执行与纪要**：[meetingRpc.ts](./apps/runtime/src/server/meetingRpc.ts)、[meetingExecution.ts](./apps/runtime/src/server/meetingExecution.ts)、[meetingMinutes.ts](./apps/runtime/src/server/meetingMinutes.ts)（`formatMeetingMinutes`、`writeMeetingMinutes`）。

### 前端（`apps/desktop`）

- **会议与成员 UI**：[NewMeeting.vue](./apps/desktop/src/components/NewMeeting.vue)（新建会话选人）、[ChatWindow.vue](./apps/desktop/src/components/ChatWindow.vue)、[Composer.vue](./apps/desktop/src/components/Composer.vue)。
- **设置、计划与纪要弹窗**：[TwinSettings.vue](./apps/desktop/src/components/TwinSettings.vue)、[TaskPlanPanel.vue](./apps/desktop/src/components/TaskPlanPanel.vue)、[MeetingDialog.vue](./apps/desktop/src/components/MeetingDialog.vue)、[MeetingMinutesDialog.vue](./apps/desktop/src/components/MeetingMinutesDialog.vue)。
- **兼容说明**：旧版 5 角色 CLI 仍保留在 `pnpm dev:cli`；日常启动（`docker compose up -d` + `pnpm dev`，后端 `3002`、前端 `5173`）与验证流程以 [数字人会议使用与恢复手册.md](./docs/数字人会议使用与恢复手册.md) 为准。

## 四、后续 UI 样式精调记录（2026-11-24 ~ 11-25）

- **左上角「参会人员」面板**：默认收起为标题栏按钮，点击展开悬浮纵向列表，切换会话自动收起；主持人置顶并标注身份，其他成员按序各占一张圆角卡片；面板宽度缩至约 `187px`，单张人员卡片高度为 `17px`。
- **会议底部输入区**：单行输入框高度缩减至 `46px`，「结束」与「发送」按钮移至输入框右侧；上下文用量条悬浮展示在输入框右上角外侧，点击仍可查看详情。

## 五、与 draw.io 设计图核对的已知差异（2026-11-25）

| 对照项 | draw.io 设计图 | 当前源码实现 |
|---|---|---|
| 规划后路由 | 规划完成后先连向主持人节点 | `task_plan_node` 后直接进入首个子任务负责人节点（也可为主持人的数字人），每次发言后由 `teamRouter` 按已完成步数选下一节点直至 `END` |
| 结束语义 | 流程末尾连向结束 | 图的 `END` 结束**单轮需求讨论**；整场会议由主持人点右下角「结束」按钮关闭并生成纪要 |
| SSE 连接 | 切换会话时新建 SSE 连接 | 前端登录后复用一条 SSE 连接，按 `sessionId` 将服务端事件分发至对应会话 |
| 知识库与检索 | 左上角保留 ES 流程与飞书 | 实际为 PostgreSQL 混合检索（`pgvector` + `pg_trgm`）+ 本地 cross-encoder 重排；ES 属旧设计，飞书接入属后续项 |

## 六、切换清理与验收基线

- **旧数据清理**：切换本机实例时已清理 14 个旧测试会话、77 条关联消息及 `data/summary/` 下 6 份旧纪要；保留原 3 个账号，并新增 5 个内置角色账号。
- **验收基线**：在隔离 PostgreSQL + 真实模型 + 双账号浏览器环境下完成验证，`pnpm typecheck`、`pnpm build` 及 235 个自动化测试（含前端 74 个）通过，覆盖个人资料与知识库隔离、只读旁听、直接问答、全员按序发言、进程中断后幂等断点续跑、归档查看及 Markdown 纪要生成。
