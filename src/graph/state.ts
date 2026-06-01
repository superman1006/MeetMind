/**
 * LangGraph 共享状态的定义。
 *
 * `AgentState` 是整个图运行时被所有节点共享的"全局变量"；每个节点函数返回
 * 的字段会按 schema 合并进来——其中 `messages` 用追加 reducer，其他字段覆盖。
 */

import { Annotation } from "@langchain/langgraph";

import type { AgentResponse } from "../agents/base.js";

/**
 * 整张图共享的状态。`messages` 走追加 reducer，其他字段直接覆盖。
 */
export const AgentStateAnnotation = Annotation.Root({
  // 架构师本轮输入的原始需求；整轮讨论中保持不变
  requirement: Annotation<string>({
    // reducer 是一个合并函数。
    // _existing是代表当前 requirement 的旧值，update 是新值；这里直接的操作是直接使用新值覆盖旧值
    reducer: (_existing, update) => update,
    // default 代表当前 requirement 没有值时的默认值,需要传入一个函数
    default: () => "",
  }),
  // 仅追加的讨论历史；每条就是一次 agent.invoke() 的产物 AgentResponse
  messages: Annotation<AgentResponse[]>({
    // 把传入的消息传入 reducer，和现有的消息列表合并成一个新的列表。这里使用 concat 来实现追加。
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
