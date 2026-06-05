/**
 * Read 工具：读取指定文件的文本内容，输出每行带行号（仿 `cat -n`）。
 *
 * 仿照 claude-code 的 FileReadTool（简化版，不做鉴权 / 图片 / PDF 等处理）：
 * 支持 offset / limit 按「行区间」读取，每行前缀「行号 + tab」，方便后续用
 * Edit 工具按行定位。和 agent 无关，普通单例，所有 agent 共用，走
 * `node:fs/promises` 的 readFile（比 shell `cat` 更稳）。内容超过 _MAX_CHARS
 * 时截断并附提示，避免一次性把超大文件灌进 LLM 上下文。
 */

import { readFile } from "node:fs/promises";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

// 单次返回给 LLM 的最大字符数，超出截断
const _MAX_CHARS = 20000;
// 不传 limit 时，单次最多读取的行数（仿 claude-code Read 默认 2000 行）
const _DEFAULT_LIMIT = 2000;

/** 给每行加上「行号 + tab」前缀（仿 cat -n），行号从 startLine 开始。 */
function addLineNumbers(lines: string[], startLine: number): string {
  const numbered: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineNo = startLine + i;
    const prefix = String(lineNo).padStart(6, " ");
    numbered.push(`${prefix}\t${lines[i]}`);
  }
  return numbered.join("\n");
}

export const readFileTool = tool(
  async ({
    file_path,
    offset,
    limit,
  }: {
    file_path: string;
    offset?: number | null;
    limit?: number | null;
  }) => {
    try {
      const raw = await readFile(file_path, "utf8");
      const allLines = raw.split("\n");
      const totalLines = allLines.length;

      // offset 是 1-indexed 的起始行号，默认从第 1 行开始
      let startLine = 1;
      if (offset && offset > 0) {
        startLine = offset;
      }
      const startIndex = startLine - 1;

      // 文件比 offset 还短：直接提示，不返回空内容
      if (startIndex >= totalLines) {
        return `(文件共 ${totalLines} 行，起始行 ${startLine} 已超出文件范围)`;
      }

      // limit 是本次最多读取的行数，默认 _DEFAULT_LIMIT
      let maxLines = _DEFAULT_LIMIT;
      if (limit && limit > 0) {
        maxLines = limit;
      }
      const endIndex = Math.min(startIndex + maxLines, totalLines);

      const picked: string[] = [];
      for (let i = startIndex; i < endIndex; i++) {
        picked.push(allLines[i]);
      }

      let body = addLineNumbers(picked, startLine);
      if (body.length > _MAX_CHARS) {
        const head = body.slice(0, _MAX_CHARS);
        body = `${head}\n\n(内容过长，已截断，仅显示前 ${_MAX_CHARS} 个字符)`;
      }
      return body;
    } catch (exc) {
      return `(读取文件失败: ${String(exc)})`;
    }
  },
  {
    name: "Read",
    description:
      "读取指定文件的文本内容，输出每行带行号（仿 cat -n）。" +
      "参数 file_path：要读取文件的绝对路径；" +
      "可选 offset：从第几行开始读（1 起，文件太大时用）；" +
      "可选 limit：最多读多少行（文件太大时用）。" +
      `单次返回超过 ${_MAX_CHARS} 个字符会被截断。`,
    // 只读文件，无副作用，风险低
    metadata: { risk: "low" },
    schema: z.object({
      file_path: z.string().describe("要读取文件的绝对路径"),
      // OpenAI 兼容的 function-calling 要求可选字段同时 nullable，否则后端报错
      offset: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe("从第几行开始读取（1 起）；仅在文件太大时提供，不需要就传 null"),
      limit: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe("最多读取的行数；仅在文件太大时提供，不需要就传 null"),
    }),
  },
);
