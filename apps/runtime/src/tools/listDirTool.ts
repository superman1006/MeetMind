/**
 * list_dir 工具：列出指定目录下的文件 / 子目录（类似 ls）。
 *
 * 和 agent 无关，普通单例，所有 agent 共用。走 `node:fs/promises` 的 readdir
 * （比 shell `ls` 更稳：不用解析输出、能处理带空格的路径），逐项标注是文件还是目录。
 */

import { readdir } from "node:fs/promises";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const listDirTool = tool(
  async ({ path }: { path: string }) => {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      if (entries.length === 0) {
        return "(目录为空)";
      }
      const lines: string[] = [];
      for (const entry of entries) {
        const kind = entry.isDirectory() ? "dir" : "file";
        lines.push(`[${kind}] ${entry.name}`);
      }
      return lines.join("\n");
    } catch (exc) {
      return `(读取目录失败: ${String(exc)})`;
    }
  },
  {
    name: "list_dir",
    description:
      "列出指定目录下的文件和子目录。参数 path：要查看的目录路径。" +
      "返回每一项并标注是 [dir] 还是 [file]。",
    schema: z.object({
      path: z.string().describe("要查看的目录路径"),
    }),
  },
);
