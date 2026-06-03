/**
 * read_file 工具：读取指定文件的文本内容（类似 cat）。
 *
 * 和 agent 无关，普通单例，所有 agent 共用。走 `node:fs/promises` 的 readFile
 * （比 shell `cat` 更稳）。内容超过 _MAX_CHARS 时截断并附提示，避免一次性把超大文件
 * 灌进 LLM 上下文。
 */

import { readFile } from "node:fs/promises";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

// 单次返回给 LLM 的最大字符数，超出截断
const _MAX_CHARS = 20000;

export const readFileTool = tool(
  async ({ path }: { path: string }) => {
    try {
      const content = await readFile(path, "utf8");
      if (content.length > _MAX_CHARS) {
        const head = content.slice(0, _MAX_CHARS);
        return `${head}\n\n(内容过长，已截断，仅显示前 ${_MAX_CHARS} 个字符)`;
      }
      return content;
    } catch (exc) {
      return `(读取文件失败: ${String(exc)})`;
    }
  },
  {
    name: "read_file",
    description:
      "读取指定文件的文本内容。参数 path：要读取的文件路径。" +
      `内容超过 ${_MAX_CHARS} 个字符会被截断。`,
    schema: z.object({
      path: z.string().describe("要读取的文件路径"),
    }),
  },
);
