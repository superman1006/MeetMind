/**
 * 简易彩色日志器。对标 Python 端 rich.logging 的 RichHandler。
 *
 * - 默认级别从 settings.logLevel 读
 * - 多模块共享同一时间戳格式
 * - 第三方噪音源（langchain / pg）暂时只能靠各自 logger 自控
 */

import chalk from "chalk";

import { getSettings } from "../config/settings.js";

const LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR"] as const;
type Level = (typeof LEVELS)[number];

function levelRank(level: Level): number {
  return LEVELS.indexOf(level);
}

function currentLevelRank(): number {
  const raw = getSettings().logLevel.toUpperCase();
  // 兼容 Python 端 "WARN" 和 "INFO" 等写法
  const normalized = raw === "WARN" ? "WARNING" : raw;
  const found = (LEVELS as readonly string[]).indexOf(normalized);
  if (found < 0) {
    return levelRank("INFO");
  }
  return found;
}

function timestamp(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `[${hh}:${mm}:${ss}]`;
}

function colorLevel(level: Level): string {
  switch (level) {
    case "DEBUG":
      return chalk.gray("DEBUG  ");
    case "INFO":
      return chalk.blue("INFO   ");
    case "WARNING":
      return chalk.yellow("WARN   ");
    case "ERROR":
      return chalk.red("ERROR  ");
  }
}

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warning: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * 返回带模块名前缀的 logger。
 */
export function getLogger(name: string): Logger {
  const prefix = chalk.dim(name);
  const make = (level: Level) => (...args: unknown[]) => {
    if (levelRank(level) < currentLevelRank()) {
      return;
    }
    const head = `${chalk.dim(timestamp())} ${colorLevel(level)} ${prefix}`;
    if (level === "ERROR") {
      console.error(head, ...args);
      return;
    }
    if (level === "WARNING") {
      console.warn(head, ...args);
      return;
    }
    console.log(head, ...args);
  };
  return {
    debug: make("DEBUG"),
    info: make("INFO"),
    warning: make("WARNING"),
    error: make("ERROR"),
  };
}

/**
 * 幂等的日志初始化占位符。当前实现里 logger 是无状态工厂，
 * 留这个函数是为了和 Python 端 setup_logging() 的调用点对齐，未来加全局过滤时改这里即可。
 */
export function setupLogging(): void {
  // no-op
}
