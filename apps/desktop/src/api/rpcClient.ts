// 这个文件:前端「发请求、等结果」的工具(一问一答模式,像打电话点餐:问一句、答一句)。
import { logger } from "./logger.js";

// 取餐号:每发一个请求就 +1,保证每个请求有独一无二的编号,用来把响应对回是哪个请求。
let nextId = 1;

// 发一个 JSON-RPC 请求:method=想让服务器执行哪个功能,params=这个功能要的参数,返回服务器给的结果。
export async function rpc<T = unknown>(
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  // 给本次请求取一个专属编号。
  const id = nextId++;

  // 真正送出去的请求体(JSON-RPC 信封)。
  const requestBody = { jsonrpc: "2.0", id, method, params };

  // 打印「发出的请求」:URL + HTTP 方法 + JSON-RPC 方法 + id + 请求体。
  logger.info({ url: "/api", httpMethod: "POST", rpcMethod: method, id, body: requestBody }, "→ 发出请求");

  // fetch=浏览器自带的“发 HTTP 请求”函数;POST 表示带数据过去;body 是真正送出去的内容,
  // 必须是字符串所以用 JSON.stringify 打包成 {jsonrpc,id,method,params};await=在这儿等服务器回话。
  const res = await fetch("/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  // 服务器回来的也是一段 JSON 文本,用 .json() 解析成 JS 对象。
  const data = await res.json();

  // 打印「收到的响应」:HTTP 状态码 + 对应的 id + 完整响应体。
  logger.info({ url: "/api", rpcMethod: method, id, status: res.status, response: data }, "← 收到响应");

  // 约定:有 error 字段就代表服务器出错了,把错误抛出去让调用方处理(比如弹窗)。
  if (data.error) {
    logger.error({ rpcMethod: method, id, error: data.error }, "RPC 返回错误");
    throw new Error(String(data.error.message ?? "RPC 出错"));
  }

  // 一切正常,只把调用方关心的 result 还回去。
  return data.result as T;
}
