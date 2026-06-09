/**
 * Write 工具：把内容整体写入指定文件（新建或覆盖），自动建好缺失的父目录。
 *
 * 仿照 claude-code 的 FileWriteTool（简化版）：和 file_edit 互补——Edit 做「局部精确替换」，
 * Write 做「整文件写入 / 新建」。和 agent 无关，普通单例，所有 agent 共用，走 `node:fs/promises`
 * 的 writeFile（不过 shell）。**会落盘覆盖文件，副作用强、风险高（risk: high）**，所以：
 *   - 鉴权走 pathAuth：目标路径必须在 PROJECT_ROOT 子树内，越权直接拒绝；
 *   - 每次写入都打 info 日志（路径 + 字节数），越权打 warning 日志，方便审计。
 * 失败 / 越权时返回提示字符串而不抛错，不打断 BaseAgent 的工具循环。
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { getLogger } from "../utils/logger.js";
import { authorizePath } from "./pathAuth.js";

const logger = getLogger("tools.write");

export const writeFileTool = tool(
  async ({ file_path, content }: { file_path: string; content: string }) => {
    // 鉴权：写入目标必须在 PROJECT_ROOT 子树内（高危操作，越权一律拒绝）
    const auth = authorizePath(file_path);
    if (!auth.ok) {
      logger.warning(auth.reason);
      return `(${auth.reason})`;
    }

    const byteLength = Buffer.byteLength(content, "utf8");
    logger.info(`Write 写入文件: ${auth.abs} (${byteLength} 字节)`);

    try {
      // 父目录可能不存在，先递归建好再写
      const dir = path.dirname(auth.abs);
      await mkdir(dir, { recursive: true });
      await writeFile(auth.abs, content, "utf8");
      return `(文件 ${auth.abs} 已写入，共 ${byteLength} 字节)`;
    } catch (exc) {
      logger.error(`Write 写入失败: ${String(exc)}`);
      return `(写入文件失败: ${String(exc)})`;
    }
  },
  {
    name: "Write",
    description:
      "把内容整体写入指定文件（不存在则新建，存在则覆盖），缺失的父目录会自动创建。" +
      "当你要产出一个全新文件、或整体重写一个文件时调用；只想局部改动请用 Edit。" +
      "参数 file_path：目标文件路径（须在项目目录内）；content：要写入的完整文本内容。",
    // 会覆盖 / 新建文件，副作用强，风险高
    metadata: { risk: "high" },
    schema: z.object({
      file_path: z.string().describe("目标文件路径（须在项目目录内）"),
      content: z.string().describe("要写入文件的完整文本内容"),
    }),
  },
);
