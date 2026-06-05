/**
 * Edit 工具：对指定文件做精确的字符串替换（仿 claude-code 的 FileEditTool 简化版）。
 *
 * 和 agent 无关，普通单例，所有 agent 共用，走 `node:fs/promises` 读改写。
 * 规则（仿照参考实现，去掉鉴权 / 读前置校验 / LSP 通知等）：
 *   - old_string 与 new_string 相同 → 提示无需修改；
 *   - 文件不存在且 old_string 为空 → 视为「新建文件」，写入 new_string；
 *   - 文件存在但 old_string 为空 → 仅当文件为空时允许（写入内容）；
 *   - old_string 在文件中找不到 → 报错；
 *   - old_string 命中多处但 replace_all=false → 报错（要求加上下文唯一定位，或显式 replace_all）；
 *   - 其余情况按 replace_all 做替换并写回磁盘。
 *
 * 替换一律用「indexOf + slice 拼接」/「split + join」手工完成，刻意不走
 * String.prototype.replace —— 后者会把 new_string 里的 `$&` / `$1` 当成特殊替换记号。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

/** 统计 needle 在 haystack 中出现的次数（不重叠）。 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") {
    return 0;
  }
  let count = 0;
  let fromIndex = 0;
  while (true) {
    const hit = haystack.indexOf(needle, fromIndex);
    if (hit === -1) {
      break;
    }
    count++;
    fromIndex = hit + needle.length;
  }
  return count;
}

/** 把 haystack 中第一处 needle 替换成 replacement（手工拼接，不解释 `$`）。 */
function replaceFirst(haystack: string, needle: string, replacement: string): string {
  const hit = haystack.indexOf(needle);
  if (hit === -1) {
    return haystack;
  }
  const before = haystack.slice(0, hit);
  const after = haystack.slice(hit + needle.length);
  return `${before}${replacement}${after}`;
}

export const fileEditTool = tool(
  async ({
    file_path,
    old_string,
    new_string,
    replace_all,
  }: {
    file_path: string;
    old_string: string;
    new_string: string;
    replace_all?: boolean | null;
  }) => {
    // old_string 与 new_string 相同：没什么可改的
    if (old_string === new_string) {
      return "(无需修改：old_string 与 new_string 完全相同)";
    }

    // 先尝试读现有文件；不存在则记为 null（可能是新建场景）
    let original: string | null = null;
    try {
      original = await readFile(file_path, "utf8");
    } catch (exc) {
      const code = (exc as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        original = null;
      } else {
        return `(读取文件失败: ${String(exc)})`;
      }
    }

    // 文件不存在：只有 old_string 为空才算「新建文件」
    if (original === null) {
      if (old_string !== "") {
        return `(文件不存在，且 old_string 非空，无法替换: ${file_path})`;
      }
      try {
        await mkdir(dirname(file_path), { recursive: true });
        await writeFile(file_path, new_string, "utf8");
        return `(已新建文件: ${file_path})`;
      } catch (exc) {
        return `(新建文件失败: ${String(exc)})`;
      }
    }

    // 文件存在但 old_string 为空：仅当文件为空时允许（视为写入初始内容）
    if (old_string === "") {
      if (original.trim() !== "") {
        return "(文件已存在且非空，无法以空 old_string 新建)";
      }
      try {
        await writeFile(file_path, new_string, "utf8");
        return `(文件 ${file_path} 已更新)`;
      } catch (exc) {
        return `(写入文件失败: ${String(exc)})`;
      }
    }

    // old_string 必须能在文件中找到
    const matches = countOccurrences(original, old_string);
    if (matches === 0) {
      return `(未找到要替换的字符串:\n${old_string})`;
    }

    const doReplaceAll = replace_all === true;
    if (matches > 1 && !doReplaceAll) {
      return (
        `(找到 ${matches} 处匹配，但 replace_all=false。` +
        "要全部替换请设 replace_all=true；只替换一处请提供更多上下文以唯一定位)"
      );
    }

    // 执行替换
    let updated: string;
    if (doReplaceAll) {
      const parts = original.split(old_string);
      updated = parts.join(new_string);
    } else {
      updated = replaceFirst(original, old_string, new_string);
    }

    try {
      await writeFile(file_path, updated, "utf8");
    } catch (exc) {
      return `(写入文件失败: ${String(exc)})`;
    }

    if (doReplaceAll) {
      return `(文件 ${file_path} 已更新，共替换 ${matches} 处)`;
    }
    return `(文件 ${file_path} 已更新)`;
  },
  {
    name: "Edit",
    description:
      "对指定文件做精确的字符串替换。" +
      "参数 file_path：文件绝对路径；old_string：要被替换的原文（须在文件中唯一，除非 replace_all=true）；" +
      "new_string：替换后的新文本；可选 replace_all：是否替换全部匹配（默认否）。" +
      "若文件不存在且 old_string 传空串，则按 new_string 新建文件。",
    // 会写磁盘，有副作用，风险中等
    metadata: { risk: "medium" },
    schema: z.object({
      file_path: z.string().describe("要编辑文件的绝对路径"),
      old_string: z
        .string()
        .describe("要被替换的原文本（须唯一，除非 replace_all=true；新建文件时传空串）"),
      new_string: z.string().describe("替换后的新文本"),
      // OpenAI 兼容的 function-calling 要求可选字段同时 nullable，否则后端报错
      replace_all: z
        .boolean()
        .nullable()
        .optional()
        .describe("是否替换文件中所有匹配；默认否，不需要就传 null 或 false"),
    }),
  },
);
