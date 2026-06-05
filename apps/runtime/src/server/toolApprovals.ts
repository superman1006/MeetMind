/**
 * 工具风险审批的挂起注册表（内存单例）。
 *
 * HITL（human-in-the-loop）：当某次工具调用的 risk 等级高于 low 时，Phase 1 工具循环
 * 不直接执行，而是发一条 SSE 事件给前端、并在这里登记一个「挂起的 Promise」等用户拍板。
 * 前端把决策通过 RPC（method=toolApproval）回传，rpcServer 调 resolve() 兑现这个 Promise，
 * 工具循环才继续（同意=执行 / 拒绝=跳过）。
 *
 * 仿 sessions.ts：纯内存、重启即清空。审批不跨进程、不落库——一轮讨论是临时态。
 */
import { getLogger } from "../utils/logger.js";

const logger = getLogger("server.toolApprovals");

/** 一个挂起审批的内部句柄：兑现回调 + 解绑 abort 监听（避免 signal 泄漏 listener）。 */
interface PendingApproval {
  // 调用方 await 的 Promise 的兑现器；true=同意，false=拒绝。
  resolve: (approved: boolean) => void;
  // 解除挂在 AbortSignal 上的监听器（兑现或取消时调一次）。
  detach: () => void;
}

// approvalId → 挂起句柄。approvalId 由 createNode 用 `${turnId}-${seq}` 拼出，一轮内唯一。
const pendingByid = new Map<string, PendingApproval>();

/**
 * 登记一个挂起审批，返回一个等用户决策的 Promise。
 *
 * - 用户同意/拒绝 → rpcServer 调 resolve(approvalId, approved) → Promise resolve 成对应布尔。
 * - 用户打断本轮 → 传入的 signal abort → Promise reject（让 Phase 1 工具循环抛错退出，
 *   外层 runExecution 检测 signal.aborted 后丢弃本轮）。无自动超时：一直等到三者之一发生。
 */
export function createPending(
  approvalId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    // 已经 abort 了就不必登记，直接 reject。
    if (signal?.aborted) {
      reject(new Error("审批已取消（讨论被打断）"));
      return;
    }

    // abort 时取消这次审批：清登记 + reject。
    function onAbort(): void {
      pendingByid.delete(approvalId);
      logger.info(`[toolApprovals] 审批 ${approvalId} 因打断被取消`);
      reject(new Error("审批已取消（讨论被打断）"));
    }

    function detach(): void {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    }

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    pendingByid.set(approvalId, {
      resolve,
      detach,
    });
    logger.info(`[toolApprovals] 登记挂起审批 ${approvalId}`);
  });
}

/**
 * 兑现一个挂起审批（rpcServer 收到前端 toolApproval 后调）。
 * 找不到对应 approvalId（已兑现 / 已取消 / 不存在）时静默返回 false，调用方幂等处理。
 */
export function resolve(approvalId: string, approved: boolean): boolean {
  const pending = pendingByid.get(approvalId);
  if (!pending) {
    logger.warning(`[toolApprovals] 收到未知审批决策 ${approvalId}（可能已取消/已处理）`);
    return false;
  }
  pendingByid.delete(approvalId);
  pending.detach();
  logger.info(`[toolApprovals] 审批 ${approvalId} 决策=${approved ? "同意" : "拒绝"}`);
  pending.resolve(approved);
  return true;
}
