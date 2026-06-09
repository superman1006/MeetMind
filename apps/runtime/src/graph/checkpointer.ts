/**
 * LangGraph checkpointer 单例（PostgresSaver）。
 *
 * 复用业务库 PG_URL 落 checkpoint（库自管表 checkpoints* 与 meetmind_* 业务表并存）。
 * 单例：model.set 触发 buildGraph() 重建图时复用同一 saver，才能读到崩溃前写下的 checkpoint。
 */
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

import { getSettings } from "../config/settings.js";
import { getPgPool } from "../database/connection/client.js";
import { getLogger } from "../utils/logger.js";

const logger = getLogger("graph.checkpointer");

let _saver: PostgresSaver | null = null;

/** 进程内单例 PostgresSaver。bootstrap 里取它跑一次 .setup() 建表。 */
export function getCheckpointer(): PostgresSaver {
  if (_saver !== null) {
    return _saver;
  }
  const settings = getSettings();
  _saver = PostgresSaver.fromConnString(settings.pgUrl);
  return _saver;
}

// PostgresSaver 自管的表名（用于 best-effort 清理；建表由 setup() 完成）。
// 删序无所谓：均按 thread_id 过滤，互不依赖。
const CHECKPOINT_TABLES = ["checkpoint_writes", "checkpoint_blobs", "checkpoints"];

/**
 * best-effort 删除某 thread 的全部 checkpoint 行。
 * 每张表各自 try/catch：删失败只 log warn、不向上抛，且一张表失败不连累其余表的清理。
 * 注：该版 PostgresSaver 无 deleteThread()，故走业务 pool 直接 DELETE。
 */
export async function deleteThreadCheckpoints(threadId: string): Promise<void> {
  const pool = getPgPool();
  for (const table of CHECKPOINT_TABLES) {
    try {
      await pool.query(`DELETE FROM ${table} WHERE thread_id = $1`, [threadId]);
    } catch (exc) {
      logger.warning(`[checkpointer] 清理 thread ${threadId} 在表 ${table} 的 checkpoint 失败（已忽略）: ${String(exc)}`);
    }
  }
}
