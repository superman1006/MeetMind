# 数字分身 + 用户主持会议（Phase 2 设计）

- 日期：2026-06-10
- 状态：设计已确认，待落实现计划
- 关联：在现有"5 固定角色 RAG 协作"基础上演进

## 1. 背景与目标

现状：系统有 5 个**编译期写死**的角色 Agent（架构师/后端/前端/测试/PM），架构师是入口+终止者，其余在 LangGraph 条件边下自由路由；每个角色有独立的 PostgreSQL 私有表 + RAG。用户账号仅做登录鉴权 + 个人记忆，与 agent 身份无关。

目标：让**每个注册用户成为一个数字分身（digital twin）agent**，拥有自己的私有知识库和工具集；任何用户都能**发起会议**并担任主持人（master），选择其他用户的分身（subagents）参会；图在运行时按本场参与者动态搭建，master 作入口+终止者，所有 agent 互相决策路由，master 决定 `done` → END。

### 核心洞察

用户描述的"master 入口+终止者、所有 agent 互相路由、master 决定 done"**正是现有左侧团队的泛化**。今天 architect 就扮演这个角色，只是被写死在 `AGENT_NAMES` / `isAgentName` / `ArchitectAgent` 子类里。本设计把"固定 5 角色"抽象成"本场参与者集合 `{master, subagents[]}`"。因 5 角色保留为**种子分身**，"经典 5 人会议"自然退化为"参与者恰好是那 5 个种子分身的一场会议"——同一套代码路径，无特例分支。

## 2. 已确认决策

| 决策点 | 选定 |
|---|---|
| 5 个内置角色 | **保留为预置种子分身**：迁进 twin 表，自带 systemPrompt + 已灌种子，可被选入会议，也是新用户冷启动样本 |
| 分身人格来源 | 注册时填一段**独立 persona 字段**，与 memory 分开 |
| 工具范围 | 全部工具可选，high/medium 风险执行前走现有 HITL 审批 |
| 鉴权强度 | **demo 级**，信任 `params.username`，不引入 token |
| 用户↔分身 | **1:1**（一个登录用户 = 一个数字分身） |
| 表名 | 数字 id 派生 `meetmind_u<id>`，用户名只做展示 |
| 知识上传 | base64-over-RPC，先支持上传 + 列表，单文件删/替换后置 |
| 预处理流水线 | 会议保留 rewrite（产 `rewritten_query`/`expansion_terms`），跳过 intent/route 的 chat-vs-team 分流 |
| 图构建时机 | **方案 A：每轮在 `runExecution` 里按持久化参与者现搭图**（见 §5） |

## 3. 范围

### In scope
- 用户注册即创建数字分身（含 persona、私有表、默认工具）
- 个人页：改资料、上传个人知识文件、勾选绑定工具
- 创建会议时选择参与的分身；master/subagents 模型
- 动态图：按 `{master, subagents[]}` 现搭，master 入口+终止
- 会议列表按"我参与的"过滤；仅 master 可删
- per-twin 工具绑定（绑定处 + 执行处双重限制）
- per-twin 记忆（每个分身用自己的 persona+memory）

### 非目标 / 后置
- 鉴权加固（session token / 防伪造 username）——demo 级即可
- 知识库单文件删除/替换（`twin.deleteKnowledge`）——预留接口，先不做
- 一人多分身、分身互为好友/可见性细粒度控制
- 会议中途增删参与者（创建后参与者固定）
- embedding 模型切换的迁移工具（仍靠 `docker compose down -v`）

## 4. 身份方案（关键：一个字符串别再当四样用）

今天 agent 名字（如 `architect`）被**同时**当作：路由 token (`next_agent`)、图节点名 (`${name}_node`)、RAG 表名键、SSE 展示名。用户名直接拼这四处会出 SQL 注入、也不利中文展示。拆成三个字段：

| 字段 | 用途 | 例子 |
|---|---|---|
| `id` (BIGSERIAL PK) | 数据库主键 | `7` |
| `agent_key` (TEXT UNIQUE) | **唯一结构化身份**：表名键 / 节点名 / 路由 token / `config.configurable.agentName` | 种子分身=`architect`；新用户=`u7` |
| `username` (TEXT UNIQUE) | 登录账号 + 列表过滤/删除鉴权身份 | `alice` |
| `display_name` (TEXT) | **只做展示**，随 SSE 下发前端 | `Alice 的分身` / `架构师` |

`agent_key` 全程保证是 SQL 安全标识符；表名 `meetmind_<agent_key>` 内插因此安全（沿用现有"受控标识符可内插"前提，但前提对象从"固定 agent 名"换成"受控生成的 agent_key"）。

- 种子分身：`agent_key` 用旧名（`architect`/`backend`/`frontend`/`tester`/`pm`），**保住它们已灌的 `meetmind_architect` 等表与种子**。
- 新用户：插入用户行拿到 `id` 后，置 `agent_key = 'u' || id`，再 `ensureAgentTable(agent_key)`。

## 5. 数据模型

### 5.1 twins（复用并扩展现有 `meetmind_user` 表，1:1 不另建表）

文件：`apps/runtime/src/database/users/userStore.ts`（DDL 在 `ensureUserTable`，约 32-44 行）

现有列：`id BIGSERIAL PK` / `username TEXT UNIQUE NOT NULL` / `password TEXT NOT NULL` / `memory TEXT`。新增：

```
persona       TEXT                  -- 角色/人格描述，注册时填，拼进 systemPrompt
tools         JSONB NOT NULL '[]'   -- 绑定的工具名列表
agent_key     TEXT UNIQUE           -- 结构化身份；新用户插入后置 'u'||id，种子分身显式设
display_name  TEXT                  -- 展示名，默认 = username
is_seed       BOOLEAN NOT NULL false -- 标记 5 个预置种子分身
created_at    TIMESTAMPTZ NOT NULL now()
```

迁移：`ensureUserTable` 内用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`（无 migration runner）。现有 `admin` 行启动时补 `agent_key='u'||id`、`tools='[]'`、`persona` 默认。

5 角色迁成种子 twin 行：启动时 upsert（`is_seed=true`，`agent_key='architect'…`，`display_name='架构师'…`，`persona` 取自现有 systemPrompt 内容），登录禁用（非真人账号，但出现在参与者选择器、可被选入会议）。它们的 RAG 表已由现有 `buildAgentsTables()` 灌好，agent_key 沿用旧名即复用。

### 5.2 sessions（= 会议，扩展 `meetmind_chat_sessions`）

文件：`apps/runtime/src/database/chat/chatStore.ts`（DDL 在 `ensureChatTables`，约 39-110 行）

新增：

```
master        TEXT                  -- 主持人 username（发起人）
participants  JSONB NOT NULL '[]'   -- 其他参与人 username 列表（不含 master）
```

- 存 **username**（非 agent_key）：前端始终带 username，列表过滤/删除鉴权可直接等值/包含判断；搭图时再用 `username[] → twin 行` 一次性查出 agent_key/persona/tools。
- 迁移：`ADD COLUMN IF NOT EXISTS` + 回填 `master := owner`；`owner` 列保留兼容。
- 列表过滤：`WHERE master = $1 OR participants @> to_jsonb($1::text)`，participants 上加 GIN 索引。
- 删除鉴权：`DELETE FROM sessions WHERE id=$1 AND master=$2`，0 行受影响回 rpcError「只有发起者可删」。同样的 master-only 判断顺手给 `renameSession` / `markSessionEnded`。
- `SessionMeta` 增 `master` / `participants` / `isMaster`（后端算 `isMaster = master===请求者`）。

### 5.3 记忆语义变化：从"会话主人一人"到"每个分身自己的"

今天 `runExecution.ts`（约 58-73 行）按 `getSessionOwner` 取**一个 owner 的 memory**，全程 `state.userMemory` 透传给**所有** agent。数字分身模型下改成：**每个 twin 用自己的 persona+memory**——在 `createNode` / `TwinAgent` 构造时按该 twin 的 `agent_key`（→ username）取它自己的 persona+memory 拼进 systemPrompt。`state.userMemory` 的"一份喂全员"逻辑废弃。

### 5.4 知识 doc id

文件：`apps/runtime/src/database/ingestion/initializer.ts`（`generateDocId`）

从 `<agent>_md5(content)[:12]` 改为 `<agent_key>_md5(filename+content)[:12]`，metadata 存 `source=filename`，为日后"按文件删/列"留口。

## 6. 动态图架构（方案 A）

### 6.1 图在哪建、怎么缓存——方案 A：每轮按需现搭

`buildGraph()` 参数化为 `buildGraph(participants: { master: string; subagents: string[] })`（值为 agent_key），每轮在 `runExecution` 开跑前现搭。注意 session 里 master/participants 存的是 **username**（§5.2），所以 `runExecution` 先用 `username[] → twin 行` 一次性查询，把它们解析成 twin 记录（拿 agent_key/persona/tools），再以 agent_key 调 `buildGraph`。这一步也是 §6.2/§6.3 里 TwinAgent 拿 persona+tools 的数据来源。

- ✅ **断点续跑天然正确**：恢复时照样从持久化参与者重搭，节点名永远对得上。`resumeExecution` 不会因参与者集合变化撞上不存在的节点名。
- ✅ **干掉 model 热切换难题**：不再有"那张唯一的图"塞 holder。每轮现搭即用当前 settings，`model.set` 只清 settings 缓存、不碰图。`index.ts` 的 `graphHolder` 与 `rpcServer.ts` 的 `model.set`（约 423 行 `graph.current = buildGraph()`）相应简化为"按需构建"。
- ⚠️ 每轮多一次搭图开销，但 `buildGraph` 只是连边 + 构造 agent（很轻），相对一轮 LLM 调用可忽略。

被否方案：B（按参与者集合 hash 缓存图）增加失效/膨胀复杂度，性能收益在 demo 不值；C（每个进行中会议挂一张图）仍要解决热切换失效且与 holder 模式冲突。

### 6.2 通用 TwinAgent

`BaseAgent.systemPrompt` 现为抽象、5 角色靠手写子类。新增通用 `TwinAgent`（`apps/runtime/src/agents/` 下），systemPrompt 由 `display_name + persona + memory + 是否 master` 拼出：

- master 版话术 = 把 `architect.ts` 的"派发/达成共识/设 done 终止"模板化。
- subagent 版话术 = 参与讨论、可路由给 master 或同伴。
- 构造时按其 `tools` 列表 `bindTools(selectedTools)`（见 §7）。
- 构造时按其 agent_key 取自己的 persona+memory（见 §5.3）。

### 6.3 路由改动（把"固定 5 角色"换成"本场参与者集合"）

文件：`apps/runtime/src/graph/builder.ts` / `route.ts` / `apps/runtime/src/config/constants.ts` / `apps/runtime/src/agents/base.ts`

- `buildAllAgents()`：不再 new 5 个固定子类，改为按本场 `[master, ...subagents]` 的 agent_key 各 new 一个 `TwinAgent`（种子分身也走 TwinAgent，persona 取自迁移来的字段）。
- 节点 / routeMap / per-node `addConditionalEdges` 循环：从遍历 `AGENT_NAMES` 改为遍历本场参与者集合（routeMap 本就是全连接，"所有 agent 互相路由"现成支持）。
- `routeAfterPreprocess`：团队入口从 `${ARCHITECT}_node` 改为 `${master}_node`。实现用**闭包**（`buildGraph` 内 `createTeamRouter(master, participants)`）而非模块级纯函数，便于把 master/参与者集合注入路由判断，匹配 `createNode` 既有闭包风格。
- `routeToWhichAgent` 兜底：`return '${ARCHITECT}_node'` 改为兜底回 `${master}_node`。
- `isAgentName`：从"查 `AGENT_NAMES` 常量"改为"查本场参与者集合"的谓词（注入参与者集合）。
- `_routingPrompt`（base.ts）：next_agent 候选列表从 `AGENT_NAMES` 改为本场同伴。
- `_buildAgentResponse`（base.ts）：`next_agent` 非法时兜底从 ARCHITECT 改为 master。
- `MeetingSummarySchema`（base.ts，约 101-126 行，按 `AGENT_NAMES` 生成 zod 字段）：改为按本场参与者生成。需确认 summary 触发路径（`chat.end` → `markSessionEnded` → summarize）并同步参数化。

### 6.4 预处理流水线

会议是显式选定参与者的，intent/route 的 chat-vs-team 分流无意义 → 会议路径**跳过** intent/route 分流，直接进 `${master}_node`。但 **rewrite 节点保留**（`createNode` 与 RAG 扩展依赖 `rewritten_query`/`expansion_terms`）。

### 6.5 并发隔离

`getRetriever(name)` 是进程级 Map 缓存、`RAGRetriever.callCount` 是可变实例态（每 invoke `.restart()`）。两场会议同时用到同一分身会共享实例、`used_rag` 串号。改为**按 (会议/线程, agent_key) 作用域**获取 retriever 与 agent 实例，避免跨会议共享可变态。

## 7. 工具：per-twin 绑定（绑定处 + 执行处双重限制）

文件：`apps/runtime/src/agents/base.ts`（绑定）、`apps/runtime/src/agents/toolLoop.ts`（执行）、`apps/runtime/src/tools/toolRegister.ts`（目录）

坑：今天不仅 `BaseAgent` 构造绑全局 `allTools`，`runToolLoop` 执行时也是拿模型吐出的工具名去**全局 allTools** 找。所以仅"少绑"无效，必须两处都改：

1. **绑定处**：`toolRegister` 加"按名查工具单例"查找；`TwinAgent` 构造时按 twin 的 `tools` 列表只 `bindTools(selectedTools)`。方案 A 每轮现搭、每轮现构造 → 工具列表天然取最新值，无"改工具要重建图"的陈旧问题。
2. **执行处**：把 allow-set 传进 `runToolLoop`，按它校验；不在集合内（或幻觉出的）工具名走**现有"未知工具回占位 ToolMessage"那条路**，不执行。这才是真正的安全边界。

HITL 不变：`tool.metadata.risk > low` 仍按现有 `tool_approval_request` 审批，与谁绑无关。

### 7.1 工具目录（前端选择器用）

新增 RPC `twin.toolCatalog` → `[{name, displayName, description, risk}]`，源自 `toolRegister`/`allTools`。约束：

- 目录**动态**：MCP 工具（`AIsearch`）bootstrap 异步 push，MCP 挂了就不在目录里——目录如实反映"当前已注册"。
- 存的工具名**解析不到时优雅降级**：twin 绑了 `AIsearch` 但本次启动 MCP 没连 → 搭图时跳过 + 记日志，不报错。
- `rag_search` 默认选中（分身访问自己私有 KB 的入口）；`Write`/`Edit` 等高危项在选择器里标红"执行需审批"。

## 8. 知识上传链路（复用现成灌库流水线）

文件：`apps/runtime/src/database/ingestion/initializer.ts`（`loadSeedsToPg` 流水线）、`apps/runtime/src/database/ingestion/loaders.ts`（按扩展名分发）

上传 = `loadSeedsToPg` 去掉"扫目录"换成"收上传文件"：

```
twin.uploadKnowledge {username, filename, contentBase64}
  → 解码 base64 落临时文件（保留原扩展名，loaders.ts 按后缀分发）
  → loadFile → splitDocs                                  （现成）
  → docId = <agent_key>_md5(filename+content)[:12]，metadata.source = filename
  → embedBatch → INSERT ON CONFLICT 进 meetmind_<agent_key>  （现成）
  → 删临时文件
```

- 用全局 embedding 模型，维度与表一致。
- 单文件上限建议 10MB（base64 膨胀约 1/3），超限拒绝。
- 配套 `twin.listKnowledge {username}` → 按 `metadata->>'source'` 分组列出文件名 + 块数。
- 后置：`twin.deleteKnowledge {username, source}`（`DELETE WHERE metadata->>'source'=$1`）。

## 9. RPC 接口清单（新增 / 改动）

文件：`apps/runtime/src/server/rpcServer.ts`（`handleRpc`，方法以 `if (body.method===...)` 分发）

新增 `twin.*`：

| RPC | 作用 |
|---|---|
| `twin.toolCatalog` | 列可绑工具（name/displayName/description/risk） |
| `twin.getProfile {username}` | 取 display_name / persona / tools / 已传知识列表 |
| `twin.setProfile {username, display_name?, persona?, tools?}` | 改个人页资料 |
| `twin.uploadKnowledge {username, filename, contentBase64}` | 上传一个知识文件 |
| `twin.listKnowledge {username}` | 按文件列出已灌知识 |
| `twin.list` | 列全部分身（username/display_name/is_seed），给参与者选择器/个人页 |
| `twin.deleteKnowledge {username, source}` | （后置）按文件删 |

改动既有：

- `user.registry`：增收 `persona` / `display_name`；建 twin 行后置 `agent_key` 并 `ensureAgentTable`。
- `session.create`：从 `{title, username}` 改为 `{title, username(=master), participants:[username...]}`。
- `session.list`：返回的 `SessionMeta` 增 `master`/`participants`/`isMaster`；过滤改"我参与的"。
- `session.delete` / `session.rename` / `chat.end`：增收请求者 username，做 master-only 鉴权。
- turn 事件（SSE）：payload 增 `display_name`（前端气泡渲染）。

## 10. 前端改动（Vue3 + Pinia + Tauri，无路由，浮层模式）

文件：`apps/desktop/src/`（组件 + stores + api）

- **注册成分身**（改 `components/RegisterDialog.vue` + `stores/auth.ts`）：加 persona（必填）+ 可选 display_name；`user.registry` 带上新字段。
- **个人页**（新 modal，仿 `components/UserMemory.vue`，挂 `SessionList` 账号菜单；新建 `stores/twin.ts` 收口 `twin.*`）：
  - 资料：改 display_name/persona → `twin.setProfile`
  - 知识库：`<input type=file>` + `FileReader.readAsDataURL` → base64 → `twin.uploadKnowledge`；`twin.listKnowledge` 列已传文件
  - 工具：`twin.toolCatalog` 渲染勾选 + 风险徽标 → `twin.setProfile {tools}`
- **创建会议选人**（改 `components/SessionList.vue` 第 230 行按钮 + `stores/sessions.ts`）：点击开参与者选择器 modal（`twin.list` 多选，master 锁定勾选，标题输入）→ `session.create {title, username, participants}`。`ChatWindow.onSend → chat.send` 协议不变。
- **列表过滤 + master-only 删除**（`SessionList.vue` + `stores/sessions.ts`）：删除按钮仅 `isMaster` 显示；`remove()` 带 username；非 master 收 rpcError 弹 toast。会议卡片可展示参与者名。
- **SSE 展示名**（`stores/chat.ts` + `api/sseClient.ts`）：气泡结构加 `display_name`，turn 事件渲染它而非 agent_key。

## 11. 实现分期

- **第①期 · 数据与身份地基**：user 表扩 twin 字段 + `agent_key` 方案 + 5 角色迁种子分身 + sessions 加 master/participants + 列表过滤 + master-only 删除。**不碰图**；"会议"在数据层成立、能建/列/删/权限隔离。可用 `tsx -e` 脚本验证。
- **第②期 · 动态图 + per-twin 能力（核心）**：`TwinAgent` + `buildGraph(participants)` 按需搭图 + 路由/兜底/summary 改本场参与者 + per-twin 记忆 + per-twin 工具（绑定+执行）+ 知识上传链路。跑通"选几个 twin 开真会议"。
- **第③期 · 前端**：注册成分身 / 个人页 / 创建会议选人 / 列表与删除 UI / SSE 展示名。

## 12. 风险与未决

- **鉴权 demo 级**：服务端信任 `params.username`，伪造可越权（删他人会议、驱动他人分身、看他人会议）。已知取舍，后置加固。
- **embedding 维度锁定**：`vector(dim)` 建表时固定，换 embedding 模型会让所有 per-user 表失配，无 migration runner，仍靠 `docker compose down -v`。用户表越多迁移成本越高。
- **冷启动**：全新分身 RAG 表空、persona 泛泛时会议内容可能空洞。本期不强制 master 先传知识；种子分身的存在缓解这点（可拉它们参会提供内容）。
- **summary 触发路径未完全核实**：`MeetingSummarySchema` 定义在 base.ts，但触发它的 `chat.end`/compaction 路径需在实现期定位并同步参数化。
- **上传体积**：base64-over-RPC 不适合大文件；10MB 上限 + 超限拒绝；大文件需客户端切分（后置）。
