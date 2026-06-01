/** 极简 JSON-RPC 2.0 客户端:POST /api(经 Vite 代理到 3002)。 */
let nextId = 1;

export async function rpc<T = unknown>(
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const id = nextId++;
  const res = await fetch("/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const data = await res.json();
  if (data.error) {
    throw new Error(String(data.error.message ?? "RPC 出错"));
  }
  return data.result as T;
}
