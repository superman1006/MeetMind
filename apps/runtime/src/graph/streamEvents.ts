/**
 * 节点通过 config.writer 发出的自定义流事件。
 * runDiscussion 用 streamMode:["custom","values"] 接到后按 kind 直接转发成 SSE 同名事件。
 */
export type NodeStreamChunk =
  | { kind: "turn_start"; turnId: string; agent_name: string; role: string }
  | { kind: "delta"; turnId: string; text: string }
  | { kind: "using_tools"; turnId: string; tool: string }
  | {
      kind: "turn_end";
      turnId: string;
      next_agent: string | null;
      done: boolean;
      used_rag: boolean;
    };
