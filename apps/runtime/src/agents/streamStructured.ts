/**
 * 从「逐帧长大的 partial 结构化对象」流里 diff 出 content 增量。
 *
 * withStructuredOutput(...).stream() 在 OpenAI 兼容后端上理想情况会逐帧吐出
 * content 不断变长的 partial；diff 出新增那截回调给 onDelta 实现真·token 打字机。
 * 若后端只在最后吐一整帧（结构化流式偶发不稳），自然退化成一段大 delta，结果仍正确。
 */
export interface ContentPartial {
  content?: string;
}

export async function streamStructuredContent<T extends ContentPartial>(
  stream: AsyncIterable<Partial<T>>,
  onDelta: (text: string) => void,
): Promise<Partial<T>> {
  let emitted = "";
  let last: Partial<T> = {};
  for await (const chunk of stream) {
    last = chunk;
    const content = chunk?.content;
    if (typeof content === "string" && content.length > emitted.length) {
      const increment = content.slice(emitted.length);
      onDelta(increment);
      emitted = content;
    }
  }
  return last;
}
