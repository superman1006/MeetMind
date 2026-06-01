import { describe, it, expect } from "vitest";
import { streamStructuredContent } from "./streamStructured.js";

async function* fakeStream(chunks: Array<{ content?: string }>) {
  for (const c of chunks) {
    yield c;
  }
}

describe("streamStructuredContent", () => {
  it("逐帧吐出 content 增量, 返回最后一帧", async () => {
    const deltas: string[] = [];
    const last = await streamStructuredContent(
      fakeStream([
        { content: "你" },
        { content: "你好" },
        { content: "你好世界", done: "true" } as { content?: string },
      ]),
      (t) => deltas.push(t),
    );
    expect(deltas).toEqual(["你", "好", "世界"]);
    expect(last.content).toBe("你好世界");
  });

  it("后端只吐一帧时退化成一段大 delta", async () => {
    const deltas: string[] = [];
    await streamStructuredContent(fakeStream([{ content: "整段一次到达" }]), (t) =>
      deltas.push(t),
    );
    expect(deltas).toEqual(["整段一次到达"]);
  });

  it("content 早期为 undefined 时不回调", async () => {
    const deltas: string[] = [];
    await streamStructuredContent(fakeStream([{}, { content: "x" }]), (t) =>
      deltas.push(t),
    );
    expect(deltas).toEqual(["x"]);
  });
});
