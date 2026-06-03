/**
 * echo 工具：真正调用命令行的 `echo` 命令，把传入文本回显出来。
 *
 * 这个工具**和 agent 无关**（不查私有表、不分角色），是个普通单例，所有 agent 共用。
 * 走 `execFile("echo", [text])`——**不过 shell**，text 作为独立 argv 传入，
 * 所以即便 text 里带分号 / 反引号也不会被当成 shell 命令，无注入风险。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const execFileAsync = promisify(execFile);

export const echoTool = tool(
  async ({ text }: { text: string }) => {
    try {
      const result = await execFileAsync("echo", [text]);
      // echo 默认在末尾补一个换行，去掉它更干净
      const output = result.stdout.replace(/\n$/, "");
      return output;
    } catch (exc) {
      return `(echo 执行失败: ${String(exc)})`;
    }
  },
  {
    name: "echo",
    description:
      "调用命令行 echo 把一段文本原样回显出来。参数 text：要回显的文本。",
    schema: z.object({
      text: z.string().describe("要回显的文本"),
    }),
  },
);
