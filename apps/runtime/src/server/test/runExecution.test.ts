import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// checkpoint 清理走真 PG，单测里整模块打桩成 no-op，保持 runExecution 纯单测、不连库。
vi.mock("../../graph/checkpointer.js", () => ({
  deleteThreadCheckpoints: vi.fn(async () => {}),
}));

import { runExecution } from "../runExecution.js";
import * as sse from "../sseServer.js";
import * as chatStore from "../../database/chat/chatStore.js";
import * as userStore from "../../database/users/userStore.js";
import type { AgentResponse } from "../../agents/base.js";

function archTurn(message: string): AgentResponse {
  return {
    agent_name: "architect",
    role: "架构师",
    message,
    next_agent: "architect",
    done: true,
    used_rag: false,
  };
}

/** 造一个假 graph:stream() 返回 [mode, chunk] 元组的异步迭代器。 */
function fakeGraph(finalMessages: AgentResponse[]) {
  return {
    async stream() {
      async function* gen() {
        yield ["custom", { kind: "turn_start", turnId: "architect-1", agent_name: "architect", role: "架构师" }];
        yield ["custom", { kind: "using_tools", turnId: "architect-1", tool: "rag_search" }];
        yield ["custom", { kind: "delta", turnId: "architect-1", text: "好" }];
        yield ["custom", { kind: "turn_end", turnId: "architect-1", next_agent: "architect", done: true, used_rag: false }];
        yield ["values", { requirement: "x", messages: finalMessages, next_agent: "architect", done: true, iteration: 1 }];
      }
      return gen();
    },
  } as unknown as Parameters<typeof runExecution>[0];
}

describe("runExecution", () => {
  let sseSpy: ReturnType<typeof vi.spyOn>;
  let appendSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sseSpy = vi.spyOn(sse, "send").mockImplementation(() => {});
    appendSpy = vi.spyOn(chatStore, "appendMessages").mockResolvedValue(undefined);
    vi.spyOn(chatStore, "getMessages").mockResolvedValue([]);
    // 本轮开始时会按会话主人加载其个人记忆;单测里打桩,避免连真库。
    vi.spyOn(chatStore, "getSessionOwner").mockResolvedValue("alice");
    vi.spyOn(userStore, "getMemory").mockResolvedValue("");
    // 断点续跑标记的读写也走真 PG,单测里打桩成 no-op。
    vi.spyOn(chatStore, "setPendingThread").mockResolvedValue(undefined);
    vi.spyOn(chatStore, "clearPendingThread").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("custom 帧(含 using_tools)转发成 SSE, 末帧后落库新 turn, 最后发 round_done", async () => {
    const sent: string[] = [];
    sseSpy.mockImplementation((_sid: string, event: string) => {
      sent.push(event);
    });

    const finalMessages = [archTurn("最终结论")];
    await runExecution(fakeGraph(finalMessages), "s1", "做个登录页");

    expect(sent).toEqual(["turn_start", "using_tools", "delta", "turn_end", "round_done"]);
    // prior 为空 → 新增 turn = 全部 finalMessages
    expect(appendSpy).toHaveBeenCalledWith("s1", finalMessages);
  });

  it("seedMessages = 已有历史 + 本轮 user 输入; 只落库新增部分", async () => {
    vi.spyOn(chatStore, "getMessages").mockResolvedValue([archTurn("上一轮")]);

    let capturedSeed: AgentResponse[] = [];
    const graph = {
      async stream(initial: { messages: AgentResponse[] }) {
        capturedSeed = initial.messages;
        async function* gen() {
          yield ["values", { messages: initial.messages, done: true }];
        }
        return gen();
      },
    } as unknown as Parameters<typeof runExecution>[0];

    await runExecution(graph, "s1", "第二轮需求");

    // 起点 = 上一轮历史 + 本轮 user 输入
    expect(capturedSeed).toHaveLength(2);
    expect(capturedSeed[0].message).toBe("上一轮");
    expect(capturedSeed[1].agent_name).toBe("user");
    expect(capturedSeed[1].message).toBe("第二轮需求");
    // 只落库 prior 之后的新增(=本轮 user turn)
    const appended = appendSpy.mock.calls[0][1] as AgentResponse[];
    expect(appended).toHaveLength(1);
    expect(appended[0].agent_name).toBe("user");
  });

  it("按会话主人加载个人记忆,注入到 graph 初始 state.userMemory", async () => {
    vi.spyOn(chatStore, "getSessionOwner").mockResolvedValue("alice");
    vi.spyOn(userStore, "getMemory").mockResolvedValue("我喜欢简洁设计");

    let capturedMemory = "<unset>";
    const graph = {
      async stream(initial: { userMemory: string; messages: AgentResponse[] }) {
        capturedMemory = initial.userMemory;
        async function* gen() {
          yield ["values", { messages: initial.messages, done: true }];
        }
        return gen();
      },
    } as unknown as Parameters<typeof runExecution>[0];

    await runExecution(graph, "s1", "做个登录页");

    expect(chatStore.getSessionOwner).toHaveBeenCalledWith("s1");
    expect(userStore.getMemory).toHaveBeenCalledWith("alice");
    expect(capturedMemory).toBe("我喜欢简洁设计");
  });
});
