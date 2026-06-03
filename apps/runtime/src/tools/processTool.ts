/**
 * list_processes 工具：调用命令行 `ps aux` 查看当前主机上的进程。
 *
 * 和 agent 无关，普通单例，所有 agent 共用。走 `execFile("ps", ["aux"])`——
 * 不过 shell，无注入风险。可选参数 filter：给了就只保留表头 + 含该关键字的行，
 * 过滤在 JS 里用显式 for 循环做（不依赖 shell 的 grep 管道）。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const execFileAsync = promisify(execFile);

/** 按 filter 关键字过滤 ps 输出：保留首行表头 + 所有命中行。 */
function filterLines(output: string, filter: string): string {
  const allLines = output.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    // 第一行是表头（USER PID ...），始终保留
    if (i === 0) {
      kept.push(line);
      continue;
    }
    if (line.includes(filter)) {
      kept.push(line);
    }
  }
  return kept.join("\n");
}

export const processTool = tool(
  async ({ filter }: { filter?: string | null }) => {
    try {
      const result = await execFileAsync("ps", ["aux"]);
      const output = result.stdout;
      if (filter) {
        return filterLines(output, filter);
      }
      return output;
    } catch (exc) {
      return `(查看进程失败: ${String(exc)})`;
    }
  },
  {
    name: "list_processes",
    description:
      "调用命令行 ps aux 查看当前主机上正在运行的进程。" +
      "可选参数 filter：只返回命令行 / 用户中含该关键字的进程行（表头始终保留）。",
    schema: z.object({
      // OpenAI 兼容的 function-calling 要求可选字段必须同时 nullable，
      // 否则后端报 "uses .optional() without .nullable()"。这里用 nullable+optional。
      filter: z
        .string()
        .nullable()
        .optional()
        .describe("可选的过滤关键字，只保留含此关键字的进程行；不过滤就传 null 或不传"),
    }),
  },
);
