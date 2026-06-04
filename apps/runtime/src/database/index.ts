/**
 * 数据库层统一入口（barrel）。
 *
 * database/ 下按职责分目录，外部一律从这里 import，不直接钻子目录：
 *   - connection/  PostgreSQL 连接池 + 扩展 + 每 agent 表的 DDL / 计数 / 删除、表名约定
 *   - models/      本地 ML 模型：embedding（文本→向量）+ reranker（cross-encoder 重排）
 *   - ingestion/   种子灌库链路：loaders（加载）→ splitters（切块）→ initializer（建表 + 入库）
 *   - retrieval/   RAG 混合检索 + rerank（RAGRetriever / getRetriever）
 *   - chat/        会话 / 消息持久化（chatStore）
 *
 * 这里只做 re-export，不含任何初始化时序——建表 / 灌库的编排仍在 bootstrap.ts。
 */

// ---------- connection：连接与建表 ----------
export * from "./connection/client.js";
export * from "./connection/constants.js";

// ---------- models：本地 embedding / rerank 模型 ----------
export * from "./models/embedding.js";
export * from "./models/reranker.js";

// ---------- ingestion：加载 → 切块 → 灌库 ----------
export * from "./ingestion/loaders.js";
export * from "./ingestion/splitters.js";
export * from "./ingestion/initializer.js";

// ---------- retrieval：RAG 检索 ----------
export * from "./retrieval/rag_retriever.js";

// ---------- chat：会话 / 消息持久化 ----------
export * from "./chat/chatStore.js";
