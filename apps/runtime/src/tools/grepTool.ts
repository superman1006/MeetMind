/**
 * grep 工具：在某个目录子树里按正则搜索文件内容，返回命中的「文件:行号:正文」列表。
 *
 * 仿照 claude-code 的 GrepTool（简化版）：和 read_file / list_dir 互补——前两者定位、查看，
 * grep 负责按内容跨文件搜。和 agent 无关，普通单例，所有 agent 共用，纯走 `node:fs/promises`
 * 递归读文件 + RegExp 匹配（不依赖系统是否装 ripgrep，不过 shell）。鉴权走 pathAuth：
 * 搜索根目录必须在 PROJECT_ROOT 子树内。失败 / 越权 / 正则非法时**返回提示字符串而不抛错**，
 * 不打断 BaseAgent 的工具循环。
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { getLogger } from "../utils/logger.js";
import { authorizePath } from "./pathAuth.js";

const logger = getLogger("tools.grep");

// 单次最多返回的命中行数，避免一次性灌爆 LLM 上下文
const _MAX_MATCHES = 100;
// 单个文件超过这个字节数就跳过（多半是产物 / 二进制 / 大数据，不该进 grep）
const _MAX_FILE_BYTES = 1024 * 1024;
// 遍历时跳过的目录名（依赖 / 产物 / 模型缓存 / 索引，对搜源码没意义且巨大）
const _SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "models",
  ".codegraph",
]);

/** 把 include 通配符（只针对文件名，如 *.ts）编译成正则，支持 * 和 ?。 */
function includeToRegExp(glob: string): RegExp {
  const specials = new Set([
    ".", "+", "^", "$", "(", ")", "[", "]", "{", "}", "|", "\\", "/",
  ]);
  let pattern = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      pattern += ".*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      pattern += ".";
      i += 1;
      continue;
    }
    if (specials.has(ch)) {
      pattern += "\\" + ch;
      i += 1;
      continue;
    }
    pattern += ch;
    i += 1;
  }
  return new RegExp("^" + pattern + "$");
}

/** 从 baseDir 递归收集文件绝对路径，跳过 _SKIP_DIRS / 过大文件。 */
async function walkFiles(baseDir: string, results: string[]): Promise<void> {
  const entries = await readdir(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(baseDir, entry.name);
    if (entry.isDirectory()) {
      if (_SKIP_DIRS.has(entry.name)) {
        continue;
      }
      await walkFiles(full, results);
    } else {
      results.push(full);
    }
  }
}

/** 在单个文件里逐行匹配 regex，命中行以「文件:行号:正文」push 进 matches。 */
async function grepOneFile(
  file: string,
  regex: RegExp,
  matches: string[],
): Promise<void> {
  // 大文件 / 读不了的文件直接跳过，不让单个文件拖垮整次搜索
  let info;
  try {
    info = await stat(file);
  } catch {
    return;
  }
  if (info.size > _MAX_FILE_BYTES) {
    return;
  }

  let content;
  try {
    content = await readFile(file, "utf8");
  } catch {
    return;
  }

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (matches.length >= _MAX_MATCHES) {
      return;
    }
    const line = lines[i];
    if (regex.test(line)) {
      const lineNo = i + 1;
      matches.push(`${file}:${lineNo}:${line}`);
    }
  }
}

export const grepTool = tool(
  async ({
    pattern,
    path: searchPath,
    include,
    ignore_case,
  }: {
    pattern: string;
    path?: string | null;
    include?: string | null;
    ignore_case?: boolean | null;
  }) => {
    const base = searchPath ? searchPath : ".";
    logger.info(
      `grep 搜索: pattern=${pattern} base=${base} include=${include ?? "*"}`,
    );

    // 鉴权：搜索根必须在 PROJECT_ROOT 子树内
    const auth = authorizePath(base);
    if (!auth.ok) {
      logger.warning(auth.reason);
      return `(${auth.reason})`;
    }

    // 编译正则（非法正则不抛错，回提示）
    let regex: RegExp;
    try {
      const flags = ignore_case === true ? "i" : "";
      regex = new RegExp(pattern, flags);
    } catch (exc) {
      return `(正则表达式非法: ${String(exc)})`;
    }

    let includeRegex: RegExp | null = null;
    if (include) {
      includeRegex = includeToRegExp(include);
    }

    try {
      const allFiles: string[] = [];
      await walkFiles(auth.abs, allFiles);

      const matches: string[] = [];
      for (const file of allFiles) {
        if (matches.length >= _MAX_MATCHES) {
          break;
        }
        // include 只针对文件名（basename）过滤
        if (includeRegex) {
          const name = path.basename(file);
          if (!includeRegex.test(name)) {
            continue;
          }
        }
        await grepOneFile(file, regex, matches);
      }

      if (matches.length === 0) {
        return `(没有匹配 ${pattern} 的内容)`;
      }
      let body = matches.join("\n");
      if (matches.length >= _MAX_MATCHES) {
        body += `\n\n(命中过多，仅显示前 ${_MAX_MATCHES} 行)`;
      }
      return body;
    } catch (exc) {
      logger.error(`grep 搜索失败: ${String(exc)}`);
      return `(grep 搜索失败: ${String(exc)})`;
    }
  },
  {
    name: "grep",
    description:
      "在项目里按正则搜索文件内容，返回命中的「文件:行号:正文」列表。" +
      "当你想定位某段代码 / 某个符号 / 某个字符串出现在哪些文件时调用。" +
      "参数 pattern：正则表达式；" +
      "可选 path：搜索的根目录（默认项目根目录）；" +
      "可选 include：只搜文件名匹配该通配符的文件（如 *.ts）；" +
      "可选 ignore_case：是否忽略大小写（默认否）。" +
      `最多返回 ${_MAX_MATCHES} 行命中。`,
    // 只读遍历 + 读文件，无副作用，风险低
    metadata: { risk: "low" },
    schema: z.object({
      pattern: z.string().describe("要搜索的正则表达式"),
      // OpenAI 兼容的 function-calling 要求可选字段同时 nullable，否则后端报错
      path: z
        .string()
        .nullable()
        .optional()
        .describe("搜索的根目录，默认项目根目录；不需要就传 null"),
      include: z
        .string()
        .nullable()
        .optional()
        .describe("只搜文件名匹配该通配符的文件，如 *.ts；不需要就传 null"),
      ignore_case: z
        .boolean()
        .nullable()
        .optional()
        .describe("是否忽略大小写；默认否，不需要就传 null 或 false"),
    }),
  },
);
