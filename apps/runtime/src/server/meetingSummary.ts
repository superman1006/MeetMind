/**
 * 会议结束整理：架构师出一份会议纪要 + 各 agent 出本职工作段，
 * 组装成一份 markdown 写到 data/summary/{sessionId}.md，过程经 SSE 推进度。
 */
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { AGENT_NAMES, ARCHITECT, ROLE_DESCRIPTIONS } from "../config/constants.js";
import { PROJECT_ROOT } from "../config/settings.js";
import type { AgentResponse, BaseAgent } from "../agents/base.js";
import { buildAllAgents } from "../graph/builder.js";
import * as chatStore from "../database/chatStore.js";
import * as sse from "./sse.js";
import { getLogger } from "../utils/logger.js";

const logger = getLogger("server.meetingSummary");

/** 把整轮转录（含 user 轮）拼成纯文本喂给 LLM。 */
export function formatTranscript(messages: AgentResponse[]): string {
  if (messages.length === 0) {
    return "";
  }
  const chunks: string[] = [];
  for (const m of messages) {
    chunks.push(`【${m.role}】(${m.agent_name})\n${m.message}`);
  }
  return chunks.join("\n\n");
}

/** 纯函数：把会议纪要 + 各 agent 工作段组装成整份 markdown。generatedAt 由调用方传入以便单测。 */
export function composeSummaryMarkdown(
  sessionId: string,
  minutes: string,
  works: Array<{ role: string; body: string }>,
  generatedAt: string,
): string {
  const lines: string[] = [];
  lines.push("# 会议纪要");
  lines.push("");
  lines.push(`> 会议 ID: ${sessionId}`);
  lines.push(`> 生成时间: ${generatedAt}`);
  lines.push("");
  lines.push("## 一、会议纪要");
  lines.push("");
  lines.push(minutes.trim());
  lines.push("");
  lines.push("## 二、各 Agent 的工作");
  lines.push("");
  for (const work of works) {
    lines.push(`### ${work.role}`);
    lines.push("");
    lines.push(work.body.trim());
    lines.push("");
  }
  return lines.join("\n");
}

/** 懒加载单例：与图各持一套无状态 agent，互不干扰；整理不走 RAG。 */
let _agents: Record<string, BaseAgent> | null = null;
function getSummaryAgents(): Record<string, BaseAgent> {
  if (!_agents) {
    _agents = buildAllAgents();
  }
  return _agents;
}

/**
 * 会议结束整理主流程：读消息 → 架构师一次性整理(纪要 + 各角色工作段) → 写单文件 → summary_done。
 * 自身 try/catch 包裹，失败 sse.send("summary_error")，绝不抛出（rpc 侧 .catch 仅二次兜底）。
 */
export async function summarizeMeeting(sessionId: string): Promise<void> {
  try {
    const messages = await chatStore.getMessages(sessionId);
    if (messages.length === 0) {
      sse.send(sessionId, "summary_error", { message: "本次会议尚无讨论内容，无法生成纪要" });
      return;
    }

    const transcript = formatTranscript(messages);
    const agents = getSummaryAgents();

    // 1) 架构师一次性整理：单次 LLM 调用同时拿到会议纪要 + 各角色工作段（平铺在 summary 上）
    const architect = agents[ARCHITECT];
    const summary = await architect.summarizeAll(transcript);

    // 2) 按 AGENT_NAMES 顺序把各角色工作段取出来；缺失 / 空白一律落「无」
    const minutes = summary.minutes ?? "";
    const works: Array<{ role: string; body: string }> = [];
    for (const name of AGENT_NAMES) {
      const role = ROLE_DESCRIPTIONS[name] ?? name;
      const raw = summary[name] ?? "无";
      const body = raw.trim() || "无";
      works.push({ role, body });
    }

    // 3) 组装并写单文件
    const generatedAt = new Date().toISOString();
    const md = composeSummaryMarkdown(sessionId, minutes, works, generatedAt);
    const dir = path.join(PROJECT_ROOT, "data", "summary");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.md`);
    await writeFile(file, md, "utf8");

    logger.info(`[meetingSummary] 会话 ${sessionId} 纪要已写入 ${file}`);
    sse.send(sessionId, "summary_done", { file });
  } catch (exc) {
    logger.error(`[meetingSummary] 会话 ${sessionId} 整理失败: ${String(exc)}`);
    sse.send(sessionId, "summary_error", { message: String(exc) });
  }
}
