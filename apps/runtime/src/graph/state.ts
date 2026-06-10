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
  // 架构师本轮输入的原始需求；整轮讨论中保持不变。
  // 这是用户「原话」，只读：展示 / 落库 / 改写失败时的兜底都用它，预处理节点绝不覆盖它。
  requirement: Annotation<string>({
    // reducer 是一个合并函数。
    // _existing是代表当前 requirement 的旧值，update 是新值；这里直接的操作是直接使用新值覆盖旧值
    reducer: (_existing, update) => update,
    // default 代表当前 requirement 没有值时的默认值,需要传入一个函数
    default: () => "",
  }),
  // rewrite_node 产出：把 requirement 做「指代消解 / 上下文改写」后的独立句。
  // 各 agent 节点读这个（而非原始 requirement）去理解 + 生成；为空时下游兜底回 requirement。
  rewritten_query: Annotation<string>({
    reducer: (_existing, update) => update,
    default: () => "",
  }),
  // rewrite_node 产出：为提升检索召回补充的同义/相关关键词（空格分隔）。
  // 只用于检索层：createNode 经 config 传给 rag_search 拼到 query 后面，不进 agent 的阅读 prompt。
  expansion_terms: Annotation<string>({
    reducer: (_existing, update) => update,
    default: () => "",
  }),
  // intent_node 产出：本轮用户输入的意图分类标签（见 INTENT_LABELS）。
  // 经 opts 透传进 _userPrompt 当一句参考提示；分类失败时为空串（下游当作无信号）。
  intent: Annotation<string>({
    reducer: (_existing, update) => update,
    default: () => "",
  }),
  // intent_node 产出：命中标签的 NLI 置信分（0~1）。仅用于打日志展示，route_node 不再据它分流。
  // 分类失败为 0。
  intent_score: Annotation<number>({
    reducer: (_existing, update) => update,
    default: () => 0,
  }),
  // intent_node 产出：top-1 与 top-2 标签的得分间距（0~1）。route_node 据它判断分类是否「有信号」：
  // 间距大 → 按命中意图分流；间距小（贴均匀线，无信号）→ 判定不了，默认走右侧回答助手。
  // 规则短路命中问候时给满间距 1；分类失败 / 只有单标签时为 0。
  intent_margin: Annotation<number>({
    reducer: (_existing, update) => update,
    default: () => 0,
  }),
  // route_node 产出：本轮分流决策。"chat" → 右侧回答助手单节点；其余（含空串）→ 架构师全团队。
  // 仅供 route_node 之后那条条件边读取分派，不进 LLM。
  route: Annotation<string>({
    reducer: (_existing, update) => update,
    default: () => "",
  }),
  // 会话主人的个人记忆；本轮开始时按 owner 加载一次，整轮保持不变，
  // 各 agent 节点读出后拼到 systemPrompt 最前面。CLI 无登录用户，恒为空串。
  userMemory: Annotation<string>({
    reducer: (_existing, update) => update,
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
