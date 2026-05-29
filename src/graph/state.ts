/**
 * LangGraph 共享状态的定义。
 *
 * `AgentState` 是整个图运行时被所有节点共享的"全局变量"；每个节点函数返回
 * 的字段会按 schema 合并进来——其中 `messages` 用追加 reducer，其他字段覆盖。
 */

import { Annotation } from "@langchain/langgraph";

/**
 * 单条 agent 发言的快照，会被追加进 AgentState.messages。
 * 字段名按 Python 端保持 snake_case，避免跨语言序列化时不一致。
 */
export interface MessageTurn {
  agent_name: string;
  role: string;
  message: string;
  /** 该 agent 指定的下一发言人；null 表示已结束 */
  next_agent: string | null;
}

/**
 * 整张图共享的状态。`messages` 走追加 reducer，其他字段直接覆盖。
 */
export const AgentStateAnnotation = Annotation.Root({
  // 架构师本轮输入的原始需求；整轮讨论中保持不变
  requirement: Annotation<string>({
    reducer: (_existing, update) => update,
    default: () => "",
  }),
  // 仅追加的讨论历史
  messages: Annotation<MessageTurn[]>({
    reducer: (existing, update) => existing.concat(update),
    default: () => [],
  }),
  // 下一待调用 agent 的名字
  next_agent: Annotation<string | null>({
    reducer: (_existing, update) => update,
    default: () => null,
  }),
  // 完成信号；架构师宣布完成时置为 true
  done: Annotation<boolean>({
    reducer: (_existing, update) => update,
    default: () => false,
  }),
  // 已执行的节点轮次数
  iteration: Annotation<number>({
    reducer: (_existing, update) => update,
    default: () => 0,
  }),
});

export type AgentState = typeof AgentStateAnnotation.State;
