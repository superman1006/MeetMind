import { describe, it, expect, vi, beforeEach } from "vitest";
import { runDiscussion } from "./runDiscussion.js";
import * as sse from "./sse.js";
import * as sessions from "./sessions.js";
import type { AgentResponse } from "../agents/base.js";

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
        yield ["custom", { kind: "delta", turnId: "architect-1", text: "好" }];
        yield ["custom", { kind: "turn_end", turnId: "architect-1", next_agent: "architect", done: true, used_rag: false }];
        yield ["values", { requirement: "x", messages: finalMessages, next_agent: "architect", done: true, iteration: 1 }];
      }
      return gen();
    },
  } as unknown as Parameters<typeof runDiscussion>[0];
}

describe("runDiscussion", () => {
  beforeEach(() => {
    sessions.resetSession("s1");
    sessions.setBusy("s1", false);
  });

  it("custom 帧转发成 SSE, values 末帧更新记忆, 最后发 round_done", async () => {
    const sent: Array<{ event: string; data: unknown }> = [];
    const spy = vi.spyOn(sse, "send").mockImplementation((_sid, event, data) => {
      sent.push({ event, data });
    });

    const finalMessages = [archTurn("最终结论")];
    await runDiscussion(fakeGraph(finalMessages), "s1", "做个登录页");

    const eventNames = sent.map((s) => s.event);
    expect(eventNames).toEqual(["turn_start", "delta", "turn_end", "round_done"]);
    expect(sessions.getMessages("s1")).toHaveLength(1);
    expect(sessions.getMessages("s1")[0].message).toBe("最终结论");

    spy.mockRestore();
  });

  it("seedMessages 含用户输入作为起点(跨轮记忆)", async () => {
    sessions.replaceMessages("s1", [archTurn("上一轮")]);
    let capturedSeed: AgentResponse[] = [];
    const graph = {
      async stream(initial: { messages: AgentResponse[] }) {
        capturedSeed = initial.messages;
        async function* gen() {
          yield ["values", { messages: initial.messages, done: true }];
        }
        return gen();
      },
    } as unknown as Parameters<typeof runDiscussion>[0];

    await runDiscussion(graph, "s1", "第二轮需求");
    expect(capturedSeed).toHaveLength(2);
    expect(capturedSeed[0].message).toBe("上一轮");
    expect(capturedSeed[1].agent_name).toBe("user");
    expect(capturedSeed[1].message).toBe("第二轮需求");
  });
});
