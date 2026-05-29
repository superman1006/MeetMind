/**
 * CLI 输出格式化工具，基于 chalk + boxen + cli-table3。
 * 还原 Python 端 rich 的 Panel / Table / 分隔线 / 系统提示效果。
 */

import boxen from "boxen";
import chalk, { type ChalkInstance } from "chalk";
import Table from "cli-table3";

import { ROLE_DESCRIPTIONS } from "../config/constants.js";

const ROLE_COLORS: Record<string, (s: string) => string> = {
  architect: (s) => chalk.bold.magenta(s),
  backend: (s) => chalk.bold.green(s),
  frontend: (s) => chalk.bold.cyan(s),
  tester: (s) => chalk.bold.yellow(s),
  pm: (s) => chalk.bold.blue(s),
  system: (s) => chalk.bold.white(s),
};

const ROLE_BORDERS: Record<string, "magenta" | "green" | "cyan" | "yellow" | "blue" | "white"> = {
  architect: "magenta",
  backend: "green",
  frontend: "cyan",
  tester: "yellow",
  pm: "blue",
  system: "white",
};

/**
 * 生成一行横向分隔线；若给了 title 则居中嵌进去。
 */
export function formatSeparator(title = "", char = "=", width = 70): string {
  if (!title) {
    return char.repeat(width);
  }
  const pad = Math.max(0, width - title.length - 2);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return `${char.repeat(left)} ${title} ${char.repeat(right)}`;
}

interface AgentPanelOptions {
  agentName: string;
  message: string;
  nextRole?: string | null;
  usedRag?: boolean;
}

/**
 * 把一个 agent 的回复渲染成带颜色边框的面板并打印到 stdout。
 */
export function printAgentInfo(opts: AgentPanelOptions): void {
  const colorFn = ROLE_COLORS[opts.agentName] ?? chalk.white;
  const borderColor = ROLE_BORDERS[opts.agentName] ?? "white";
  const roleDesc = ROLE_DESCRIPTIONS[opts.agentName] ?? opts.agentName;

  const bodyLines: string[] = [opts.message.trim()];

  const footerParts: string[] = [];
  if (opts.usedRag) {
    footerParts.push("调用过 RAG 工具");
  }
  if (opts.nextRole) {
    footerParts.push(`Next: ${chalk.bold(opts.nextRole)}`);
  }
  if (footerParts.length > 0) {
    bodyLines.push("");
    bodyLines.push(chalk.dim(footerParts.join(" | ")));
  }

  const panel = boxen(bodyLines.join("\n"), {
    title: colorFn(roleDesc),
    titleAlignment: "left",
    borderStyle: "round",
    borderColor,
    padding: { top: 0, right: 1, bottom: 0, left: 1 },
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
  });
  console.log(panel);
}

/**
 * 打印一行系统级提示，前缀是反色高亮的 SYSTEM 标签。
 */
export function printSystem(message: string): void {
  const tag = chalk.bgBlue.bold.white(" SYSTEM ");
  console.log(`${tag} ${message}`);
}

/**
 * 打印一个标题面板（cyan 边框，居中标题）。
 */
export function printBanner(title: string, subtitle?: string): void {
  const body = subtitle ? `${title}\n${chalk.dim(subtitle)}` : title;
  console.log(
    boxen(body, {
      borderStyle: "round",
      borderColor: "cyan",
      padding: 1,
      align: "center",
    }),
  );
}

/**
 * 打印一个 messages 历史表格。
 */
export function printMessagesTable(rows: Array<{
  index: number;
  agentName: string;
  nextRole: string | null;
  preview: string;
}>): void {
  const table = new Table({
    head: [
      chalk.bold.cyan("#"),
      chalk.bold.cyan("agent"),
      chalk.bold.cyan("→ next"),
      chalk.bold.cyan("message 预览 (80 字)"),
    ],
    colWidths: [4, 12, 12, 60],
    wordWrap: true,
    style: { head: [], border: [] },
  });
  for (const r of rows) {
    table.push([String(r.index), r.agentName, r.nextRole ?? "", r.preview]);
  }
  console.log(chalk.bold("messages 历史"));
  console.log(table.toString());
}

/**
 * 一个轻量的"颜色 chalk 选项"辅助，用于 cli/main 里组合复杂文本。
 */
export function colorize(role: string): ChalkInstance {
  switch (role) {
    case "architect":
      return chalk.bold.magenta;
    case "backend":
      return chalk.bold.green;
    case "frontend":
      return chalk.bold.cyan;
    case "tester":
      return chalk.bold.yellow;
    case "pm":
      return chalk.bold.blue;
    default:
      return chalk.bold.white;
  }
}
