/**
 * 全局日志器（基于 pino）。
 *
 * - 每条日志都带：时间戳 + 级别 + 来源标签 `app=runtime` + 模块名 `name`。
 * - 用 pino-pretty 作为「进程内」输出流（不走 worker thread transport），在 tsx/ESM 下更稳。
 * - 对外保留旧 API：`getLogger(name)` 返回 `{ debug, info, warning, error }`；
 *   `warning` 映射到 pino 的 `warn`，老调用点（全是单字符串）无需改动。
 * - 既支持老的单字符串调用 `logger.info("xxx")`，也支持 pino 风格的 `logger.info({a:1}, "msg")`
 *   （后者用于打印请求体 / 响应体这类结构化字段）。
 */

import { pino, type Logger as PinoLogger } from "pino";
import pretty from "pino-pretty";

import { getSettings } from "../config/settings.js";

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warning: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

type PinoLevel = "debug" | "info" | "warn" | "error";

// 把 settings.logLevel（兼容 "WARN"/"WARNING" 两种写法）转成 pino 级别名。
function resolveLevel(): PinoLevel {
  const raw = getSettings().logLevel.toUpperCase();
  if (raw === "DEBUG") {
    return "debug";
  }
  if (raw === "WARN" || raw === "WARNING") {
    return "warn";
  }
  if (raw === "ERROR") {
    return "error";
  }
  return "info";
}

// pino-pretty 输出流：时间在前，级别居中，正文格式化成 `[runtime] [<模块>] <消息>`，
// 结构化字段（如请求体）会被 pretty 缩进打印在下一行。
const prettyStream = pretty({
  colorize: true,
  // SYS: 前缀 = 用本机时区(否则 pino-pretty 默认按 UTC 打印,会和前端 [desktop] 的本地时间差 8 小时)。
  translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
  ignore: "pid,hostname,app,name",
  messageFormat: "[{app}] [{name}] {msg}",
});

// 根 logger：base 里钉死 app=runtime，所有子 logger 都会带上，用来区分 runtime / desktop。
const rootLogger = pino(
  {
    level: resolveLevel(),
    base: { app: "runtime" },
  },
  prettyStream,
);

// 把一次调用转发给 pino：第一个参数是对象 → 当结构化字段 + 第二个参数当消息；
// 否则把所有参数拼成一条消息字符串（兼容老的单字符串调用点）。
function forward(target: PinoLogger, level: PinoLevel) {
  return (...args: unknown[]): void => {
    if (args.length === 0) {
      return;
    }
    const first = args[0];
    if (typeof first === "object" && first !== null) {
      const msg = typeof args[1] === "string" ? args[1] : undefined;
      target[level](first as Record<string, unknown>, msg);
      return;
    }
    const parts: string[] = [];
    for (const a of args) {
      parts.push(typeof a === "string" ? a : String(a));
    }
    target[level](parts.join(" "));
  };
}

/** 返回带模块名前缀的 logger（pino child）。 */
export function getLogger(name: string): Logger {
  const child = rootLogger.child({ name });
  return {
    debug: forward(child, "debug"),
    info: forward(child, "info"),
    warning: forward(child, "warn"),
    error: forward(child, "error"),
  };
}

/**
 * 幂等的日志初始化占位符（保留旧调用点 bootstrap.ts）。
 * pino 是无状态工厂，这里无需做事；未来加全局过滤 / 文件落盘时改这里即可。
 */
export function setupLogging(): void {
  // no-op
}
