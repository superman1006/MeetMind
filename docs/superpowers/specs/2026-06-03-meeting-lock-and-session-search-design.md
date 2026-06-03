# 会议永久锁定（修 bug）+ 会话标题搜索 + 图标/悬浮提示 — 设计文档

日期: 2026-06-03
分支: ts-dev
状态: 已确认，开始实现

承接 [2026-06-03-meeting-end-summary-design.md](2026-06-03-meeting-end-summary-design.md)：那一版加了「结束会议 + 生成纪要」；本版修复其遗留 bug 并把「已结束」做成持久化，外加会话搜索 UI。

## 1. 目标

### A. 会议永久锁定（修 bug #1）
当前 bug：会议结束后，输入框回车/点发送会被拦（弹「会话已结束」，正确），但**「结束」按钮仍可点**，再点会**再次触发整理**（重跑 6 次 LLM、覆盖 `data/summary/{sessionId}.md`）。

目标：一个会话 = 一个会议。会议结束后**不允许任何操作**——不能再发送、不能再次结束/总结，且该状态**持久化到后端**，刷新/重启应用后依然锁定。

### B. 会话标题搜索 + 新图标 + 悬浮提示
会话列表展开态右上角换成两个图标：**[🔍 搜索] [▢ 收缩/展开]**。
- 收缩/展开：功能不变（`ui.toggleSidebar()`），只把 `«`/`»` 字符换成面板 SVG 图标。
- 搜索：点开一个居中模态，在**已加载的会话标题**里即时过滤（纯前端，无后端），点结果跳到该会话。
- 两个图标鼠标悬浮时显示**自定义深色气泡提示**（仿截图，不用原生 title），不加键盘快捷键。

## 2. 关键决策（已与用户确认）

| 决策点 | 结论 |
|---|---|
| 「已结束」状态 | **持久化到后端**（sessions 表加 `ended` 列）；刷新/重启后仍锁定；服务端也拒绝再 `chat.send` / `chat.end`。 |
| 失败可重试? | 锁定发生在「点结束被接受」时；若整理失败，会话仍判为已结束、**不可重试整理**（符合「不能再次总结」，记录在案）。 |
| 搜索范围 | **仅会话标题**，纯前端过滤 `sessions.list`，不新增后端接口。 |
| 悬浮提示 | **自定义气泡**（深色圆角浮层，悬浮显示在图标下方）。 |
| 快捷键 | **不加**（提示文案只显示「搜索」/「收缩会话列表」）。 |
| 结束按钮锁定形式 | 会议结束后**置灰禁用**（`:disabled="busy || ended"`，与 busy 时一致）；发送/回车维持现有「会话已结束」提示。 |

## 3. Feature A — 会议永久锁定

### 3.1 后端数据层 `apps/runtime/src/database/chatStore.ts`
- `SessionMeta` 增 `ended: boolean`。
- `ensureChatTables`：建表 SQL 给 sessions 加 `ended BOOLEAN NOT NULL DEFAULT false`；并补一条幂等 `ALTER TABLE ${sessions} ADD COLUMN IF NOT EXISTS ended BOOLEAN NOT NULL DEFAULT false`（兼容旧库，照搬现有 `tool` 列的写法）。
- `listSessions` / `createSession`：select / 构造时带上 `ended`（`createSession` 新建必为 false，可直接 `ended: false`）。
- 新增 `export async function markSessionEnded(sessionId: string): Promise<void>` → `UPDATE ${sessions} SET ended = true WHERE id = $1`。
- 新增 `export async function isSessionEnded(sessionId: string): Promise<boolean>` → `SELECT ended FROM ${sessions} WHERE id = $1`；未知 id 返回 false。

### 3.2 后端 RPC `apps/runtime/src/server/rpc.ts`
- `chat.end`：参数校验后，**先**判 `if (await chatStore.isSessionEnded(sessionId)) return rpcError(id, -32000, "会议已结束,无法再次结束")`；再判 busy；通过后 `await chatStore.markSessionEnded(sessionId)`，然后才 `setBusy(true)` + 不 await 地 `summarizeMeeting`。
- `chat.send`：参数校验后，加 `if (await chatStore.isSessionEnded(sessionId)) return rpcError(id, -32000, "会议已结束,无法继续讨论")`（防御性，前端已拦）。

> runtime 用 tsx 起、不 watch：改完 rpc.ts **必须重启 runtime 进程**。

### 3.3 前端 store
- `apps/desktop/src/stores/sessions.ts`：`SessionMeta` 增 `ended?: boolean`（`session.list` 回填）。
- `apps/desktop/src/stores/chat.ts`：新增 action `hydrateEnded(metas: { id: string; ended?: boolean }[])`——遍历，`ended` 为真则 `this.endedBySession[id] = true`。（`markEnded` / `isEnded` 保持不变，仍是 UI 真值来源。）

### 3.4 前端接线
- `apps/desktop/src/App.vue`：`onMounted` 里 `await sessions.load()` 之后调 `chat.hydrateEnded(sessions.list)`，把后端的 ended 灌进 chat store。
- `apps/desktop/src/components/Composer.vue`：**核心修复**——结束按钮改 `:disabled="busy || ended"`；标题文案在 ended 时给「会议已结束」。其余（发送/回车 → emit blocked → 弹「会话已结束」）不动。

### 3.5 测试 `apps/runtime/src/server/rpc.test.ts`
beforeEach 给 `isSessionEnded` / `markSessionEnded` 打桩（默认 `isSessionEnded` → false）。新增用例：
- `chat.end` 已结束会话 → `-32000`，且**不**调 `summarizeMeeting`。
- `chat.end` 空闲未结束 → 调 `markSessionEnded("s1")` 且调 `summarizeMeeting`。
- `chat.send` 已结束会话 → `-32000`。

## 4. Feature B — 搜索 + 图标 + 悬浮提示

### 4.1 新建 `apps/desktop/src/components/Tooltip.vue`
轻量悬浮提示，纯 CSS（无 JS 定时器）。
- props：`label: string`、`placement?: "top" | "bottom"`（默认 `bottom`，仿截图显示在图标下方）。
- 模板：`<span class="tip-wrap"><slot /><span class="tip" :class="placement">{{ label }}</span></span>`。
- 样式：`.tip` 绝对定位、`opacity:0; visibility:hidden; pointer-events:none`；`.tip-wrap:hover .tip` → 可见（带 ~0.12s 过渡 + 小延迟）。深色底 `#2c2c2e`、白字、圆角、小号字、`white-space:nowrap`、`z-index` 高于侧栏。

### 4.2 新建 `apps/desktop/src/components/SessionSearch.vue`
居中模态（复用 `ConfirmDialog.vue` 的 `.overlay` 思路，对话框换成搜索盒样式）。
- props：`sessions: SessionMeta[]`。emit：`select: [id: string]`、`close: []`。
- 内部 `query` ref；computed `results`：用**显式 for 循环**过滤 `sessions`，标题（小写）`includes` 查询（小写、trim）；query 为空时返回全部（当快速切换器用）。
- 行内匹配高亮：小工具函数把标题按首个匹配位置切成 `{ before, match, after }`（显式 `indexOf` + `slice`，不写链式），命中段用 `<mark>` 包。
- 每行：左侧标题（高亮）、右侧创建时间（`created_at` 存在时格式化成 `YYYY-M-D HH:MM`，复用 MessageBubble 同款 `two()` 补零逻辑）。
- 交互：`onMounted` 自动 focus 输入框；Esc / 点遮罩 / 点 X → emit `close`；点某行 → emit `select(id)`。
- 顶部搜索盒：放大镜 SVG + `<input placeholder="搜索会话标题…">` + 右侧 X 按钮。
- 空结果时显示一行「没有匹配的会话」。

### 4.3 改 `apps/desktop/src/components/SessionList.vue`
- 引入 `Tooltip`、`SessionSearch`；新增 `searchOpen` ref。
- 展开态 header 右侧：把单个 `«` 按钮换成两个 `Tooltip` 包裹的图标按钮：
  - 搜索：`<Tooltip label="搜索"><button @click="searchOpen = true">{放大镜 SVG}</button></Tooltip>`。
  - 收缩：`<Tooltip label="收缩会话列表"><button @click="ui.toggleSidebar()">{面板 SVG}</button></Tooltip>`。
- 收缩态 rail：`»` 展开按钮换成面板 SVG（外面包 `Tooltip label="展开会话列表"`，placement 可用默认）。
- 模板末尾：`<SessionSearch v-if="searchOpen" :sessions="sessions.list" @select="onPick" @close="searchOpen = false" />`；`onPick(id)` = `sessions.select(id)` + `searchOpen = false`。
- 图标：直接内联 SVG（`stroke="currentColor"`，~18px，线性风格），不引图标库。面板图标 = 圆角矩形 + 靠左竖分隔线；搜索图标 = 放大镜。
- `.toggle` 现有样式微调以容纳 SVG（居中、`svg { width/height }`）。

### 4.4 搜索范围说明
`sessions.list` 已含全部会话标题（`session.list` 启动即拉），故搜索是纯内存过滤，**零后端改动、零延迟**。

## 5. 错误处理与边界
- **已结束会话再发/再结束**：后端 `-32000`；前端结束按钮已置灰、发送已拦，正常不会触发，属二次防御。
- **整理失败**：会话仍为 ended（已持久化），弹窗显示错误；不可重试整理（已记录的权衡）。
- **hydrateEnded 时机**：仅 App 启动 `sessions.load()` 后灌一次；会话存续期内 chat store 内存即真值，切换会话不丢。
- **搜索 query 为空**：列全部会话（快速切换器语义）。
- **created_at 缺失**：该行右侧时间留空，不报错。
- **旧库无 ended 列**：`ALTER ... ADD COLUMN IF NOT EXISTS` 幂等补列，默认 false。

## 6. 涉及文件清单
新增：
- `apps/desktop/src/components/Tooltip.vue`
- `apps/desktop/src/components/SessionSearch.vue`

修改：
- `apps/runtime/src/database/chatStore.ts`（+`ended` 列 / `markSessionEnded` / `isSessionEnded` / `SessionMeta.ended`）
- `apps/runtime/src/server/rpc.ts`（`chat.end` 加 ended 守卫 + 持久化；`chat.send` 加 ended 守卫）
- `apps/runtime/src/server/rpc.test.ts`（+3 用例 + 打桩）
- `apps/desktop/src/stores/sessions.ts`（`SessionMeta.ended`）
- `apps/desktop/src/stores/chat.ts`（+`hydrateEnded`）
- `apps/desktop/src/App.vue`（启动灌 ended）
- `apps/desktop/src/components/Composer.vue`（结束按钮 `:disabled="busy || ended"`）
- `apps/desktop/src/components/SessionList.vue`（图标 + Tooltip + 搜索入口）

## 7. 验证
- 后端：`pnpm --filter @meetmind/runtime test`（vitest，rpc.test.ts 新用例）+ `pnpm typecheck`。
- 前端：`pnpm typecheck`；最短路 `pnpm dev:runtime`(3002) + `pnpm dev:desktop`(5173)，浏览器实操——结束会议后确认三处（回车/发送/结束）全部不可操作；刷新页面后仍锁定；搜索框按标题过滤、点结果跳转；两个图标悬浮出提示气泡。**改 rpc.ts 后重启 runtime**。
