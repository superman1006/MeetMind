import { buildMeetingGraph } from "../graph/meetingGraph.js";
import * as meetings from "../database/chat/meetingStore.js";
import { getContextMessages } from "../database/chat/chatStore.js";
import { getTwins } from "../database/users/twins.js";
import { getSettings } from "../config/settings.js";
import { getLogger } from "../utils/logger.js";
import { send } from "./sseServer.js";
import * as sessions from "./sessions.js";
import * as approvals from "./toolApprovals.js";

const logger = getLogger("server.meetingExecution");
// 审批 ID 在等待期间绑定主持人账号，RPC 用它核对处理权限。
const approvalOwners = new Map<string, string>();

export function approveMeetingTool(username: string, approvalId: string, approved: boolean): boolean {
  if (approvalOwners.get(approvalId) !== username) return false;
  return approvals.resolve(approvalId, approved);
}

// 登记本轮的取消控制器，后台执行时通过 SSE 汇报进度。
export function startMeetingRound(meeting: meetings.Meeting, round: meetings.MeetingRound, resume: boolean): void {
  const controller = new AbortController();
  sessions.setController(meeting.id, controller);
  execute(meeting, round, controller.signal, resume).catch((error: unknown) => {
    logger.error(`保存轮次 ${round.id} 的状态失败，可重新打开会议恢复：${String(error)}`);
    send(meeting.id, "error", { message: "轮次状态保存失败，重新打开会议后可恢复。" }, [meeting.owner, ...meeting.participants]);
  });
}

async function execute(
  meeting: meetings.Meeting, round: meetings.MeetingRound, signal: AbortSignal, resume: boolean,
): Promise<void> {
  // getTwins 按给定顺序返回数字人。主持人放在首位，建图时据此确定主持人节点。
  const audience = [meeting.owner, ...meeting.participants];
  // 普通事件发给主持人与参会人，工具审批请求只发给主持人。
  const emit = (event: string, data: Record<string, unknown>, hostOnly?: boolean) => {
    send(meeting.id, event, data, hostOnly ? [meeting.owner] : audience);
  };
  emit("round_start", { roundId: round.id, requirement: round.requirement, resume });
  try {
    const twins = await getTwins(audience);
    if (twins.length !== audience.length) throw new Error("参会数字人资料已缺失");
    const history = await getContextMessages(meeting.id);
    const graph = buildMeetingGraph(round, twins, emit, async (approvalId, approvalSignal) => {
      approvalOwners.set(approvalId, meeting.owner);
      try {
        return await approvals.createPending(approvalId, approvalSignal);
      } finally {
        approvalOwners.delete(approvalId);
      }
    });
    const recursionLimit = Math.max(twins.length, getSettings().maxIterations) + 10;
    await graph.invoke({ requirement: round.requirement, messages: history }, { signal, recursionLimit });
    await meetings.finishRound(round, "completed");
    emit("round_done", { roundId: round.id, done: true });
  } catch (error) {
    // 中断和执行失败使用不同的终态，已提交的步骤保存在数据库。
    const status = signal.aborted ? "interrupted" : "failed";
    await meetings.finishRound(round, status);
    if (signal.aborted) {
      emit("round_done", { roundId: round.id, interrupted: true, done: false });
    } else {
      logger.error(`会议轮次 ${round.id} 失败：${String(error)}`);
      emit("error", { message: "本轮执行失败，已保存完成的消息和步骤。" });
    }
  } finally {
    sessions.setBusy(meeting.id, false);
    sessions.clearController(meeting.id);
  }
}
