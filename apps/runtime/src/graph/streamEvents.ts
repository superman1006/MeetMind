/**
 * 节点通过 config.writer 发出的自定义流事件。
 * runExecution 用 streamMode:["custom","values"] 接到后按 kind 直接转发成 SSE 同名事件。
 */
export type NodeStreamChunk =
  | { kind: "turn_start"; turnId: string; agent_name: string; role: string }
  | { kind: "delta"; turnId: string; text: string }
  | { kind: "using_tools"; turnId: string; tool: string }
  | {
      // risk>low 的工具执行前发出：请前端弹审批框，等用户同意/拒绝。
      kind: "tool_approval_request";
      turnId: string;
      // 一轮内唯一的审批编号（`${turnId}-${seq}`）；前端回传 toolApproval 时带上它。
      approvalId: string;
      tool: string;
      risk: string;
      args: Record<string, unknown>;
    }
  | {
      kind: "tool_result";
      turnId: string;
      name: string;
      args: Record<string, unknown>;
      result: string;
    }
  | {
      kind: "turn_end";
      turnId: string;
      next_agent: string | null;
      done: boolean;
      used_rag: boolean;
    };
