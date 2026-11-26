import { z } from "zod";
import * as meetings from "../database/chat/meetingStore.js";
import * as aliases from "../database/chat/chatStore.js";
import * as twins from "../database/users/twins.js";
import { listTwinKnowledge, uploadTwinKnowledge } from "../database/ingestion/twinKnowledge.js";
import { getDefaultCapabilities } from "../tools/capabilities.js";
import { getMeetingTools } from "../tools/meetingTools.js";
import { getLoadedSkills } from "../tools/skillTool.js";
import { cleanBadChars } from "../utils/utils.js";
import { handleRpc, type GraphHolder, type RpcRequest } from "./rpcServer.js";
import { getMeetingMinutes, writeMeetingMinutes } from "./meetingMinutes.js";
import { approveMeetingTool, startMeetingRound } from "./meetingExecution.js";
import { closeLoginClients, send } from "./sseServer.js";
import { compactSession } from "./compaction.js";
import { summarizeTitle } from "./titleSummary.js";
import * as sessions from "./sessions.js";
import { getLogger } from "../utils/logger.js";

const logger = getLogger("server.meetingRpc");
const credentials = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(1024),
  display_name: z.string().trim().max(100).default(""),
  persona: z.string().trim().max(4000).default(""),
});
const profileSchema = z.object({
  display_name: z.string().trim().min(1).max(100),
  persona: z.string().max(4000),
  memory: z.string().max(32000),
  tools: z.array(z.string()),
  skills: z.array(z.string()),
});
// 会议信息供成员读取，发言、结束和恢复类操作由主持人控制。
const readMethods = new Set(["session.messages", "session.get", "session.plans", "chat.minutes"]);
const hostMethods = new Set([
  "session.archive", "session.rename", "chat.send", "chat.end", "chat.retrySummary", "chat.interrupt",
  "chat.resume", "chat.getResumable", "chat.discardResumable", "chat.compact", "chat.summaryTitle",
]);
class RpcProblem extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

function publicMeeting(meeting: meetings.Meeting, username: string) {
  return {
    id: meeting.id,
    title: meeting.title,
    owner: meeting.owner,
    participants: meeting.participants,
    created_at: meeting.created_at,
    ended_at: meeting.ended_at,
    status: meeting.status,
    ended: meeting.status === "ended",
    archived: meeting.archived_at !== null,
    isHost: meeting.owner === username,
    running: sessions.isBusy(meeting.id),
    minutesStatus: meeting.minutes_status,
    minutesFilename: meeting.minutes_filename,
  };
}

function startMinutes(meeting: meetings.Meeting): void {
  writeMeetingMinutes(meeting.id).catch((error: unknown) => {
    logger.error(`读取会议 ${meeting.id} 的纪要状态失败：${String(error)}`);
    send(meeting.id, "summary_error", { message: "纪要任务启动失败，可重试。" }, [meeting.owner, ...meeting.participants]);
  });
}

// HTTP 层把登录令牌和写 Cookie 的回调交给此入口，这里统一返回 JSON-RPC 结果或错误。
export async function handleMeetingRpc(
  graph: GraphHolder, body: RpcRequest, token: string, setLoginCookie: (token: string | null) => void, localRequest: boolean,
) {
  const id = body.id ?? null;
  try {
    const result = await dispatch(graph, body, token, setLoginCookie, localRequest);
    return { jsonrpc: "2.0" as const, id, result };
  } catch (error) {
    if (error instanceof RpcProblem) return { jsonrpc: "2.0" as const, id, error: { code: error.code, message: error.message } };
    if (error instanceof z.ZodError) return { jsonrpc: "2.0" as const, id, error: { code: -32602, message: "参数格式或长度不正确" } };
    logger.error({ method: body.method, errorType: error instanceof Error ? error.name : typeof error }, "会议请求处理失败");
    return { jsonrpc: "2.0" as const, id, error: { code: -32603, message: "服务暂时无法完成该操作" } };
  }
}

async function dispatch(
  graph: GraphHolder, body: RpcRequest, token: string, setLoginCookie: (token: string | null) => void, localRequest: boolean,
): Promise<unknown> {
  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") throw new RpcProblem(-32600, "无效的 JSON-RPC 请求");
  const method = body.method;
  const params = body.params ?? {};
  if (method === "user.login" || method === "user.registry") {
    const input = credentials.parse(params);
    if (method === "user.registry") {
      // 新账号创建时默认勾选当前全部可用工具与 skills，避免用户注册后还要手动逐项开启。
      const capabilities = getDefaultCapabilities(input.username);
      const ok = await twins.registerTwin(
        input.username, input.password, input.display_name, input.persona, capabilities.tools, capabilities.skills,
      );
      return ok ? { ok } : { ok, reason: "exists" };
    }
    if (!localRequest && input.username === "admin" && input.password === "admin") return { ok: false };
    const login = await twins.loginTwin(input.username, input.password);
    if (!login) return { ok: false };
    if (token) {
      await twins.logoutTwin(token);
      closeLoginClients(token);
    }
    setLoginCookie(login);
    return { ok: true, username: input.username };
  }

  const account = await twins.authenticateTwin(token);
  if (!account) throw new RpcProblem(-32001, "请先登录");
  const { username } = account;
  if (method === "user.me") return { username };
  if (method === "user.logout") {
    await twins.logoutTwin(token);
    closeLoginClients(token);
    setLoginCookie(null);
    return { ok: true };
  }

  if (method === "model.get" || method === "model.set" || method === "model.test") {
    if (username !== "admin") throw new RpcProblem(-32003, "仅管理员可配置模型");
    const response = await handleRpc(graph, body);
    if ("error" in response) throw new RpcProblem(response.error.code, response.error.message);
    return response.result;
  }

  if (method === "twin.list") return twins.listTwins();
  if (method === "twin.catalog") {
    const tools = [];
    for (const entry of getMeetingTools(username)) {
      tools.push({ name: entry.name, description: entry.description, risk: (entry as { metadata?: Record<string, unknown> }).metadata?.risk ?? "low" });
    }
    const skills = [];
    for (const entry of getLoadedSkills()) {
      skills.push({ name: entry.name, description: entry.description });
    }
    return { tools, skills };
  }
  if (method === "twin.getProfile" || method === "twin.setProfile" || method === "twin.listKnowledge" || method === "twin.uploadKnowledge") {
    const [twin] = await twins.getTwins([username]);
    if (!twin) throw new RpcProblem(-32001, "数字人资料不存在");
    if (method === "twin.getProfile") {
      const { display_name, persona, memory, tools, skills } = twin;
      return { display_name, persona, memory, tools, skills };
    }
    if (method === "twin.setProfile") {
      const profile = profileSchema.parse(params);
      const allowedTools = new Set(getMeetingTools(username).map((entry) => entry.name));
      const allowedSkills = new Set(getLoadedSkills().map((entry) => entry.name));
      for (const name of profile.tools) {
        if (!allowedTools.has(name) && !twin.tools.includes(name)) throw new RpcProblem(-32602, "工具不可用");
      }
      for (const name of profile.skills) {
        if (!allowedSkills.has(name) && !twin.skills.includes(name)) throw new RpcProblem(-32602, "技能不可用");
      }
      await twins.saveTwin(username, profile);
      return { ok: true };
    }
    if (method === "twin.listKnowledge") return listTwinKnowledge(twin.agent_key);
    const upload = z.object({ filename: z.string().min(1).max(255), contentBase64: z.string().max(14 * 1024 * 1024) }).parse(params);
    try {
      const chunks = await uploadTwinKnowledge(twin.agent_key, upload.filename, upload.contentBase64);
      return { chunks };
    } catch (error) {
      throw new RpcProblem(-32000, error instanceof Error && /^(文件|不支持)/.test(error.message) ? error.message : "知识文件导入失败");
    }
  }

  if (method === "session.list") {
    const records = await meetings.listMeetings(username);
    return records.map((record) => publicMeeting(record, username));
  }
  if (method === "session.create") {
    const input = z.object({
      title: z.string().trim().max(200).default(""),
      participants: z.array(z.string().min(1).max(100)).default([]),
    }).parse(params);
    // 主持人由登录账号决定，参会名单保留原顺序并跳过主持人及重复账号。
    const seen = new Set([username]);
    const participants: string[] = [];
    for (const name of input.participants) {
      if (seen.has(name)) continue;
      seen.add(name);
      participants.push(name);
    }
    const records = await twins.getTwins(participants);
    if (records.length !== participants.length) throw new RpcProblem(-32602, "有选中的数字人不存在");
    const meeting = await meetings.createMeeting(username, input.title || "新会话", participants);
    send(meeting.id, "session_updated", {}, [username, ...participants]);
    return publicMeeting(meeting, username);
  }

  if (method === "toolApproval") {
    const input = z.object({ approvalId: z.string(), approved: z.boolean() }).parse(params);
    if (!approveMeetingTool(username, input.approvalId, input.approved)) throw new RpcProblem(-32003, "审批已结束或无权处理");
    return { ok: true };
  }

  if (!readMethods.has(method) && !hostMethods.has(method)) throw new RpcProblem(-32601, "未知的操作");
  const sessionId = z.string().min(1).max(100).parse(params.sessionId);
  // 查询会议时同时校验成员身份，主持人操作再额外检查所有者。
  const meeting = await meetings.getMeeting(sessionId, username);
  if (!meeting) throw new RpcProblem(-32003, "会议不存在或没有查看权限");
  if (hostMethods.has(method) && meeting.owner !== username) throw new RpcProblem(-32003, "仅主持人可操作此会议");
  const audience = [meeting.owner, ...meeting.participants];

  switch (method) {
    case "session.get": return publicMeeting(meeting, username);
    case "session.messages": return meetings.getMeetingHistory(sessionId);
    case "session.plans": return meetings.listRounds(sessionId);
    case "chat.minutes": return getMeetingMinutes(meeting);
    case "session.rename": {
      const title = z.string().trim().min(1).max(200).parse(params.title);
      await aliases.renameSession(sessionId, title);
      send(sessionId, "session_updated", {}, audience);
      return { ok: true };
    }
    case "session.archive": {
      const archived = z.boolean().parse(params.archived);
      if (!await meetings.setArchived(sessionId, archived)) throw new RpcProblem(-32000, "请先处理未完成的轮次");
      send(sessionId, "session_updated", {}, audience);
      return { ok: true };
    }
    case "chat.send": {
      const input = z.object({
        requirement: z.string().trim().min(1).max(24000),
        requestId: z.string().uuid().optional(),
      }).parse(params);
      const requirement = cleanBadChars(input.requirement);
      if (!requirement.trim()) throw new RpcProblem(-32602, "需求不能为空");
      // 先占用进程内执行槽，beginRound 再用数据库事务登记在途轮次。
      if (!sessions.claimSession(sessionId)) throw new RpcProblem(-32000, "上一轮讨论仍在进行");
      let started = false;
      try {
        const roundId = await meetings.beginRound(meeting, requirement, input.requestId);
        if (!roundId) throw new RpcProblem(-32000, "会议已结束、已归档或有未完成的轮次");
        const round = await meetings.getRound(roundId);
        if (!round) throw new Error("轮次创建后缺失");
        if (round.status === "running") {
          startMeetingRound(meeting, round, false);
          started = true;
        }
        return { ok: true, roundId };
      } finally {
        if (!started) sessions.setBusy(sessionId, false);
      }
    }
    case "chat.interrupt": {
      sessions.getController(sessionId)?.abort();
      return { ok: true };
    }
    case "chat.getResumable": {
      return { resumable: Boolean(meeting.pending_thread_id && !sessions.isBusy(sessionId)) };
    }
    case "chat.resume":
    case "chat.discardResumable": {
      if (!meeting.pending_thread_id || !sessions.claimSession(sessionId)) {
        throw new RpcProblem(-32000, "没有可操作的未完成轮次");
      }
      let started = false;
      try {
        // 占用执行槽后重读在途标记，确认仍是本次请求看到的轮次。
        const current = await meetings.getMeeting(sessionId, username);
        if (current?.pending_thread_id !== meeting.pending_thread_id) {
          throw new RpcProblem(-32000, "未完成的轮次已处理");
        }
        const round = await meetings.getRound(meeting.pending_thread_id);
        if (!round) {
          if (method === "chat.resume") throw new RpcProblem(-32000, "这是旧版断点，请放弃此轮后发送新消息");
          await aliases.clearPendingThread(sessionId);
        } else if (method === "chat.resume") {
          startMeetingRound(meeting, round, true);
          started = true;
        } else {
          await meetings.finishRound(round, "interrupted");
          send(sessionId, "plan_updated", { roundId: round.id }, audience);
        }
        return { ok: true };
      } finally {
        if (!started) sessions.setBusy(sessionId, false);
      }
    }
    case "chat.compact": {
      if (meeting.pending_thread_id || meeting.archived_at || meeting.ended_at) return { compacted: false };
      return compactSession(sessionId);
    }
    case "chat.summaryTitle": {
      if (meeting.title !== "新会话" || meeting.status !== "in_progress" || meeting.archived_at) return { ok: false };
      const requirement = z.string().min(1).max(24000).parse(params.requirement);
      const title = await summarizeTitle(requirement);
      if (!title) return { ok: false };
      const latest = await meetings.getMeeting(sessionId, username);
      if (latest?.title !== "新会话") return { ok: false };
      await aliases.renameSession(sessionId, title);
      send(sessionId, "session_updated", {}, audience);
      return { ok: true, title };
    }
    case "chat.end": {
      const ended = await meetings.endMeeting(sessionId);
      if (!ended) throw new RpcProblem(-32000, "请在会议空闲时结束");
      send(sessionId, "session_updated", {}, audience);
      startMinutes(ended);
      return { ok: true };
    }
    case "chat.retrySummary": {
      if (!["pending", "failed"].includes(meeting.minutes_status ?? "")) throw new RpcProblem(-32000, "没有需要重试的纪要");
      startMinutes(meeting);
      return { ok: true };
    }
  }
}
