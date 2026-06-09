/**
 * 工具路径鉴权（沙箱）：把文件类工具的可访问范围限制在 PROJECT_ROOT 子树之内。
 *
 * 五个角色 Agent 由 LLM 自由驱动调用工具，必须防止它们读 / 写到项目目录之外
 * （越权访问 /etc、用户主目录等）。所有涉及文件路径的工具（grep / glob / Write）
 * 统一走这里鉴权：把传入路径解析成绝对路径，校验它确实落在 PROJECT_ROOT 内，
 * 越权时返回 { ok: false }，调用方据此返回提示字符串、不执行真正操作。
 *
 * 和 agent 无关，纯函数，所有工具共用（类似 logger 这种被工具 import 的 util）。
 */

import path from "node:path";
import { PROJECT_ROOT } from "../config/settings.js";

export interface AuthResult {
  ok: boolean;
  // 解析后的绝对路径（ok=false 时也给出，方便日志记录越权目标）
  abs: string;
  // ok=false 时的中文原因，可直接回给 LLM
  reason: string;
}

/**
 * 校验 target 是否落在 PROJECT_ROOT 子树内。相对路径锚定到 PROJECT_ROOT，
 * 绝对路径原样解析。用 path.relative 的结果判断越权：以 ".." 开头说明跳出了
 * 根目录，结果是绝对路径（如 Windows 跨盘符）也算越权。
 */
export function authorizePath(target: string): AuthResult {
  const abs = path.resolve(PROJECT_ROOT, target);
  const rel = path.relative(PROJECT_ROOT, abs);

  let allowed = true;
  if (rel.startsWith("..")) {
    allowed = false;
  }
  if (path.isAbsolute(rel)) {
    allowed = false;
  }

  if (!allowed) {
    return {
      ok: false,
      abs,
      reason: `路径越权：${abs} 不在项目根目录 ${PROJECT_ROOT} 之内，已拒绝`,
    };
  }
  return { ok: true, abs, reason: "" };
}
