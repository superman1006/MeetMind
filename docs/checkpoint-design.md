# 会话 Checkpoint / 快照与崩溃恢复 —— 设计文档

> 目标：会话进行中一旦出问题（SSE 断、客户端断、runtime 进程崩），能尽量不丢，
> 并在重启后恢复到出问题前的状态。
>
> 本文只做设计与复杂度评估，**不含实现**。

---

## 0. 结论先行（TL;DR）

**这件事不是一个功能，是三类故障**，难度差一个数量级，必须分开做：

| 故障 | 服务端进程 | 难度 | 推荐手段 |
|---|---|---|---|
| A. SSE 断 / 客户端刷新、关页 | **还活着** | ★☆☆ 低 | SSE 事件补发（Last-Event-ID + 环形缓冲） |
| B. runtime 进程崩 / 重启 | **没了** | ★★★ 中 | LangGraph 原生 PostgresSaver checkpointer |
| C. 轮内增量可见 / 重连接回 | —— | ★★☆ 中低 | 增量落库 + “in-flight 轮”查询接口 |

其余三条结论：

- **一个重要的认知纠正**：硬崩溃（OOM / SIGKILL / 断电）时，进程**没有机会**“赶紧保存快照”。
  所以正确思路不是“出事时存快照”，而是 **持续 checkpoint（写前日志式）**——每跑完一个节点就落一份状态，
  崩溃后天然停在最后一份上。只有“优雅错误”（SSE 写失败、catch 到异常）才谈得上主动存。

- **不要手写快照系统。** LangGraph 自带 checkpointer 机制（`@langchain/langgraph-checkpoint-postgres` 的
  `PostgresSaver`），用 `thread_id = sessionId` 跑图，它会**在每个 super-step（每个 agent 节点）后自动把
  `AgentState` 落到 PostgreSQL**，重启后 `graph.stream(null, {thread_id})` 即可从断点续跑。我们的图状态
  （[state.ts](../apps/runtime/src/graph/state.ts)）本来就是可序列化的，几乎是为这个机制量身定做的。

- **整体复杂度：中等。** 真正的“checkpoint”本身（B 的核心）只是几行接线；大头工作量在
  **“重启后决定哪些轮要续、怎么续”** 和 **“前端怎么重新接回一轮没跑完的讨论”** 这两处编排上。

---

## 1. 现状：一轮讨论的状态都在哪

调用链（关键文件）：

```
rpcServer "chat.send"  (rpcServer.ts:107)
  ├─ sessions.setBusy(true)          // 内存 Set
  ├─ sessions.setController(ctrl)    // 内存 Map（打断用）
  └─ runExecution(graph, sessionId, requirement, signal)   // 不 await，立刻回 {ok:true}
        ├─ chatStore.getMessages()   // 取历史当跨轮记忆
        ├─ graph.stream(initialState, {streamMode:["custom","values"], signal})
        │     for await (item):
        │       custom 帧 → sseServer.send(sessionId, kind, event)   // 推前端，不落库
        │       values 帧 → finalState = chunk                       // 只在内存累积
        ├─ chatStore.appendMessages(newTurns)   // ★ 只在整轮跑完才落库
        └─ sseServer.send("round_done")
```

**轮内状态的存活范围：**

| 状态 | 存在哪 | 进程崩了会怎样 |
|---|---|---|
| `AgentState`（messages / next_agent / iteration…） | 内存，`graph.stream` 的迭代变量 | **全丢**，从未落库 |
| 已经吐给前端的 delta 文字 | 仅经 `config.writer` 推走，不留存 | **全丢** |
| `busySessions` / `controllersBySession` | 内存 | 清空（注释明说“重启可重置”） |
| 已结束轮的发言 | PostgreSQL（`appendMessages`） | 保留 |
| 被打断的轮 | **故意不落库** | —— |

> 关键结论：**轮内没有任何持久化**。整轮要么全部成功落库，要么整轮丢失。
> 这正是“恢复”需要补的洞。

SSE 侧（[sseClient.ts](../apps/desktop/src/api/sseClient.ts)）：单条全局 `/events` 长连，`EventSource`
断线会自动重连，但**服务端没给帧编号、断线期间的帧不会补发**——重连后只能收到“之后”的新帧，中间那段
delta 永久丢失，前端 live 气泡会卡在思考中。

---

## 2. 把“突发问题”拆成三类

### 故障 A：SSE 断 / 客户端刷新 / 关页 —— **服务端还活着**

- runtime 进程没事，`graph.stream` 还在跑，`appendMessages` 最终照样会落库。
- 唯一损失：客户端**漏看了断线期间的实时 delta**；刷新后从 DB 读历史能看到**最终结果**，
  但“正在打字”的那段过程没了，live 气泡可能卡住。
- 本质：**事件补发 / 重新同步问题，不是快照问题。**

### 故障 B：runtime 进程崩 / 重启 —— **整轮在内存里，全没了**

- `AgentState` 从未落库 → 这一轮彻底消失，重启后无从续起。
- 本质：**真正的 checkpoint 问题。** 需要轮内持续落状态，才能续跑。

### 故障 C：轮内可见性 / 重连接回（贯穿 A、B）

- 即便 A 里服务端还在跑，前端**重连后也无法知道“这个会话现在正跑到第几个 agent、in-flight 那条
  turn 的文字是什么”**——因为这些只在内存、且只通过一次性 SSE 推过。
- 需要一个“当前 in-flight 轮状态”的可查询入口 + 增量落库。

---

## 3. 认知纠正：别指望“出事时存快照”

“一旦出问题就速度保存快照”这个直觉，对**优雅错误**成立，对**硬崩溃不成立**：

- OOM 被内核杀、`kill -9`、断电、容器被驱逐 —— 进程拿不到任何回调，`catch`/`finally`/`process.on('exit')`
  都**不保证执行**。这种情况下“出事再存”根本来不及。
- 工程上可靠的做法是 **持续 checkpoint（类似数据库的 WAL）**：每完成一个最小工作单元就落一份状态，
  系统天然停在“最后一个成功落盘的点”。崩溃恢复 = 读最后一个 checkpoint 重放。

所以方案的核心是**“跑的过程中一直在存”**，而不是“崩的瞬间抢存”。
对优雅错误（`runExecution` 的 `catch`、SSE `send` 失败）可以**额外**触发一次显式 flush，但它只是锦上添花。

---

## 4. 分层方案

按“投入 → 收益”从低到高排，可独立交付，也可叠加。

### Tier 1 —— SSE 事件补发（解决故障 A，★☆☆ 低）

> 服务端还活着时，让客户端断线重连后“补回漏掉的帧”。

做法：
1. **每个会话一个有界环形缓冲**（内存即可，比如最近 N=500 条事件），`sseServer.send` 时给每帧
   分配自增 `seq` 并写入缓冲。
2. SSE 帧带上 `id: <seq>`。`EventSource` 重连时**会自动在请求头带 `Last-Event-ID`**（浏览器原生行为）。
3. 服务端 `/events` 收到 `Last-Event-ID` 后，先把缓冲里 `seq > lastId` 的帧**逐条补发**，再接回实时流。

改动面：
- [sseServer.ts](../apps/runtime/src/server/sseServer.ts)：加 per-session seq + 环形缓冲，`send` 时写 `id:`。
- [httpServer.ts](../apps/runtime/src/server/httpServer.ts)：`/events` 处理里读 `Last-Event-ID` 并回放。
- 前端基本不用改（`EventSource` 自带 Last-Event-ID）；live 气泡逻辑可能要容忍“补发的一批 delta”。

复杂度：**低。** 纯服务端、纯内存、无 schema 变更。**但不跨进程重启**（缓冲在内存，进程崩就没了）。
这层只对“服务端没崩、只是客户端/网络断”有效——也就是日常最高频的那类抖动。

---

### Tier 2 —— LangGraph PostgresSaver checkpointer（解决故障 B 的核心，★★★ 中）

> 让轮内状态**持续落 PostgreSQL**，进程崩了也能从断点续跑。

LangGraph 的 checkpointer 是专门干这个的，机制是：图 compile 时挂一个 `checkpointer`，运行时传
`configurable.thread_id`；之后**每跑完一个节点，它把整份 `AgentState` 序列化进 checkpoint 表**。

做法：
1. 装 `@langchain/langgraph-checkpoint-postgres`，建 `PostgresSaver`（复用现有 `getPgPool()` 的连接），
   首启调一次 `.setup()` 建 checkpoint 表。
2. [builder.ts](../apps/runtime/src/graph/builder.ts) 里 `workflow.compile({ checkpointer })`。
3. [runExecution.ts](../apps/runtime/src/server/runExecution.ts) 里 `graph.stream(initialState, {
   configurable: { thread_id: sessionId }, ... })`——**用 sessionId 当 thread_id**，天然一会话一条 checkpoint 线。
4. 续跑：`graph.stream(null, { configurable: { thread_id: sessionId } })`，传 `null` 表示
   “不给新输入、从最后 checkpoint 接着跑”。

**粒度说明（重要）：** checkpoint 是**每个节点（每个 agent 发完一整轮言）**存一次，**不是每个 token**。
所以崩溃后：已说完的 agent 不重跑；**正在说一半被打断的那个 agent 会整段重跑**（重新吐 delta）。
对本项目完全够用——丢的最多是“某个 agent 这一轮的半句话”，且重跑会补回。

改动面：builder.ts（compile 挂 checkpointer）、runExecution.ts（传 thread_id）、bootstrap 处建表，
新增一张 LangGraph 托管的 checkpoint 表（它自己管 schema，我们不用设计）。

复杂度：**checkpointer 本身接线只有几行。** 中等难度来自后面的编排（Tier 2.5）。

> 注意：现在 `busySessions` 是内存的，进程崩后“这个会话当时在跑”这一事实也丢了。要做重启续跑，
> 得把“运行中”这个标记**也持久化**（比如 sessions 表加一列 `running boolean` 或 `running_round_id`），
> 否则重启后不知道该续哪些会话。

---

### Tier 2.5 —— 重启后的恢复编排（★★☆ 中低，但是真正的工作量所在）

checkpointer 解决了“状态在”，但**“重启后到底怎么续”**要自己定策略：

启动时（bootstrap）：
1. 查 DB 里所有 `running = true` 的会话（即崩溃时正在跑的）。
2. 对每个，二选一策略：
   - **自动续跑**：后台对每个调 `graph.stream(null, {thread_id})` 接着跑完，跑完照常 `appendMessages` + `round_done`。
     优点是用户无感；风险是重启瞬间一批会话同时恢复跑、压垮 LLM 配额，需要限流/排队。
   - **标记待恢复**：不自动跑，把这些会话标成“上次中断”，等用户下次打开该会话时给个“继续上一轮”按钮，点了才续。
     更可控，推荐先做这个。

**推荐：** 先做“标记 + 手动续”，稳定后再考虑自动续。

复杂度：中低，但**琐碎**——要处理“续跑时 SSE 没有客户端在听怎么办”（先落库，等前端接回时从 DB +
Tier 1 缓冲重放）、限流、幂等（同一轮别被续两次）。

---

### Tier 3 —— 轮内增量落库 + 前端接回（解决故障 C，★★☆ 中低）

> 让“没跑完的轮”对前端**可见、可重新接入**。

两个子项：

**3a. 增量落库**：`runExecution` 里每收到一个 `turn_end`（一个 agent 说完），就**立即 `appendMessages`
这一条**，而不是攒到 `round_done` 才整批落。这样：
- 刷新页面后 `getMessages` 能看到“已说完的部分”，不必等整轮结束。
- 与 Tier 2 的 checkpoint 互补：checkpoint 给“引擎续跑”，增量落库给“前端看历史”。
- 需配套：被打断/出错时，要决定这些已落的半轮**留还是删**（现状是整轮丢；增量落库后语义要重新定义）。

**3b. in-flight 查询 + 接回**：加一个 RPC（如 `chat.state(sessionId)`）返回
“该会话是否在跑 / 跑到哪个 agent / in-flight turn 的当前文字”。前端打开/重连一个会话时先查它，
把 live 气泡恢复到正确状态，再接 SSE 实时流（配合 Tier 1 的补发）。

复杂度：中低。3a 改动小但要想清语义；3b 是新增只读接口 + 前端 store 的接回逻辑。

---

## 5. 端到端恢复流程（三层叠满后的样子）

```
进程崩溃
  └─ checkpoint 表里留着每个会话最后一个完成节点的 AgentState（Tier 2）
  └─ DB 里留着已落的“半轮”发言（Tier 3a）
  └─ sessions.running 标记说明崩溃时谁在跑（Tier 2.5）

重启
  └─ bootstrap 扫 running 会话 → 标记“待恢复”（Tier 2.5）

用户打开会话
  └─ 前端 chat.state 查到“上次中断，可恢复” → 显示历史(DB) + “继续”按钮（Tier 3b）
  └─ 点继续 → chat.resume → graph.stream(null,{thread_id}) 从断点续跑（Tier 2）
       └─ 续跑产生的 delta 走 SSE 推 + 落环形缓冲（Tier 1）

讨论中网络抖动 / 刷新
  └─ EventSource 自动重连，带 Last-Event-ID → 服务端补发漏帧（Tier 1）
  └─ 前端无缝接回 live 气泡
```

---

## 6. 复杂度与工作量评估

| 模块 | 解决的故障 | 工程量 | 风险/坑 |
|---|---|---|---|
| Tier 1 SSE 补发 | A（客户端断、最高频） | 0.5–1 天 | 缓冲大小、补发顺序、前端容忍批量 delta |
| Tier 2 checkpointer 接线 | B（进程崩） | 0.5 天 | 装包、`.setup()` 建表、thread_id 贯通 |
| Tier 2.5 重启恢复编排 | B | 1–2 天 | running 标记持久化、限流、幂等、无客户端续跑 |
| Tier 3a 增量落库 | C | 0.5 天 | 半轮/打断的去留语义要重定义 |
| Tier 3b in-flight 查询接回 | C | 1 天 | 前端 store 接回 live 气泡 |
| 测试（含崩溃模拟） | 全部 | 1 天 | 模拟 kill -9 续跑、断线补发的端到端验证 |

**总体：中等规模，约 4.5–6 人天**，可分阶段独立上线。

**不复杂的部分：** checkpoint 本身（靠 LangGraph，几行）、SSE 补发（纯内存）。
**复杂/琐碎的部分：** 重启后的恢复编排、半轮数据的去留语义、前端无缝接回。

---

## 7. 推荐落地顺序

1. **先做 Tier 1（SSE 补发）。** 投入最小、覆盖最高频的“网络/客户端抖动”，且不动数据模型，风险最低。
2. **再做 Tier 3a（增量落库）。** 让刷新后能看到半轮结果，立刻改善体感。
3. **然后 Tier 2 + 2.5（checkpointer + 手动续跑）。** 真正抗进程崩；先做“手动续”再考虑“自动续”。
4. **最后 Tier 3b（接回）打磨无缝体验。**

> 一句话：**核心快照能力直接交给 LangGraph 的 PostgresSaver，别手写**；我们的活儿主要是
> “持久化运行标记 + 重启恢复编排 + 前端接回”这套外围胶水。整体中等复杂度，且能拆成几个低风险小步上线。

---

## 8. 几个要提前定的产品/语义决策

1. 进程崩后正在跑的轮，重启**自动续**还是**等用户点继续**？（建议先手动）
2. 一轮跑一半被打断/出错，已落库的“半轮”**保留**还是**回滚**？（现状是整轮丢，增量落库后需重定义）
3. 续跑会消耗 LLM 配额，多个会话同时恢复要不要**限流/排队**？
4. checkpoint 表要不要**定期清理**已结束会话的旧 checkpoint（防止无限增长）？
