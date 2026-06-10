# 会议纪要

> 会议 ID: 5f7d2dde-adf8-45ac-b0d9-ef566d9e28de
> 生成时间: 2026-06-10T02:25:40.770Z

## 一、会议纪要

用户要求复刻 GitHub 项目 MeetMind——一个多 Agent RAG 协作系统（5 角色 Agent 通过 LangGraph 编排 + 私有知识库 + SSE 流式讨论）。会议按角色轮流拆解任务，达成以下共识：

- **复刻范围待 PM 澄清**：是否 1:1 复刻、内部用还是 SaaS、技术栈是否沿用 LangGraph + pgvector。
- **三阶段交付**：P0 最小可跑链路（单 Agent RAG 流式输出 + 5 角色独立知识库 + next_agent 路由多轮讨论）→ P1 协作体验（SSE 流式推送、前端多角色渲染、done 判定）→ P2 增强（本地 embedding/rerank、Tauri 桌面壳、知识库管理 UI）。
- **技术方案**：后端 pnpm monorepo，runtime 引擎 LangGraph + pgvector + SSE；前端 Vue3 + EventSource/ReadableStream 消费 SSE；消息格式统一为 `{agent_name, content, next_agent, done}`。
- **总工时约 40.5 人天**，建议按 P0→P1→P2 迭代。

待办：PM 需确认复刻范围与技术栈选型；前端需确认 Tauri 桌面壳优先级、知识库上传格式、路由可视化优先级。

## 二、各 Agent 的工作

### 架构师

- 把控整体技术架构，确保 LangGraph 编排 + pgvector + SSE 方案落地可行
- 协调各角色接口对齐（SSE 消息格式、next_agent/done 状态机约定）
- 评审后端讨论引擎设计、前端组件架构与测试策略
- 跟进 P0→P1→P2 三阶段交付节奏

### 后端工程师

- 数据模型设计与建表：agents / documents(pgvector+ivfflat) / sessions / messages
- 核心 API 开发：POST /api/sessions、POST /api/sessions/{id}/discuss、GET /api/sessions/{id}/stream、知识库上传与检索接口
- LangGraph 讨论引擎编排：用户输入→architect→RAG→LLM→SSE 推送→next_agent 路由→done 终止
- SSE 流式推送实现，消息格式对齐 `{agent_name, content, next_agent, done}`
- 工时 ~16.5d：数据模型 2d + 编排引擎 5d + RAG 管线 3d + SSE 1.5d + 知识库 API 2d + 联调 2d

### 前端工程师

- 页面开发：会话列表（左侧栏）+ 讨论区（右侧主区域）+ 设置页（知识库管理/Agent 配置）
- SSE 消费：EventSource 或 fetch ReadableStream，解析 `{agent_name, content, next_agent, done}`
- 消息渲染：按 agent_name 映射头像/颜色，Markdown 渲染，流式打字动画
- 前端 max_iterations 兜底反循环保护
- 需 PM 确认：Tauri 桌面壳优先级、知识库上传支持格式、Agent 路由图可视化归属 P1/P2
- 工时 ~11d：布局骨架 2d + SSE 渲染 3d + 会话 CRUD 2d + 上传 UI 1.5d + 联调 2.5d

### 测试工程师

- 单元测试：RAG 检索正确性、next_agent/done 状态机、SSE 解析器
- 集成测试：完整 5 Agent 讨论链路、知识库上传→向量化→检索端到端、pgvector 命中率
- 边界测试：max_iterations 超限终止、空知识库降级、SSE 断连重接、会话隔离、非法格式拒绝
- 性能测试：单轮 RAG < 500ms、5 轮全链路 < 15s、SSE 首字节 < 1s
- 工时 ~10d：用例设计 3d + 自动化 3d + 压测 2d + 回归 2d

### 产品经理

- 澄清复刻范围：1:1 复刻还是取其思想自建？内部使用还是 SaaS？技术栈是否沿用 LangGraph + pgvector？
- 确认 P0/P1/P2 优先级排序与里程碑节点
- 答复前端待确认事项：Tauri 桌面壳是否 P2、知识库上传支持格式、Agent 路由图可视化优先级
- 制定成功指标：完整跑通多 Agent 讨论链路、每个 Agent 回复能引用私有知识库
- 工时 ~3d
