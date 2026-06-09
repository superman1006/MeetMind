/**
 * glob 工具：按通配符模式（如 `**​/*.ts`）在某个目录子树里查找文件，返回匹配到的绝对路径列表。
 *
 * 仿照 claude-code 的 GlobTool（简化版）：和 `list_dir` 互补——list_dir 只列一层，glob 能递归
 * 按文件名模式找。和 agent 无关，普通单例，所有 agent 共用，走 `node:fs/promises` 的 readdir
 * 递归遍历（不过 shell）。鉴权走 pathAuth：搜索根目录必须在 PROJECT_ROOT 子树内。
 * 失败 / 越权时**返回提示字符串而不抛错**，不打断 BaseAgent 的工具循环。
 *
 * 只支持最常用的通配符：`**`（任意层级，含 /）、`*`（单层内任意字符）、`?`（单层内单个字符）。
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { getLogger } from "../utils/logger.js";
import { authorizePath } from "./pathAuth.js";

const logger = getLogger("tools.glob");

// 单次最多返回的文件数，避免大仓库一次性灌爆 LLM 上下文
const _MAX_RESULTS = 200;
// 遍历时跳过的目录名（依赖 / 产物 / 模型缓存 / 索引，对找源码没意义且巨大）
const _SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "models",
  ".codegraph",
]);

/**
 * 把 glob 模式编译成正则。逐字符扫描：`**` → `.*`（跨目录），`*` → `[^/]*`（单层），
 * `?` → `[^/]`，其余正则特殊字符转义。结果用来匹配「相对搜索根」的路径。
 */
function globToRegExp(glob: string): RegExp {
  const specials = new Set([
    ".", "+", "^", "$", "(", ")", "[", "]", "{", "}", "|", "\\",
  ]);
  let pattern = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      // 连续两个 * 视为 **：匹配任意层级（含 /）
      if (glob[i + 1] === "*") {
        pattern += ".*";
        i += 2;
        // 吃掉 ** 紧跟的一个 /，让 `**​/x` 也能匹配顶层的 x
        if (glob[i] === "/") {
          i += 1;
        }
        continue;
      }
      pattern += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      pattern += "[^/]";
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

/**
 * 从 searchRoot 递归遍历，把「相对 searchRoot 的路径」匹配 regex 的文件绝对路径
 * push 进 matched。跳过 _SKIP_DIRS；匹配数达到 _MAX_RESULTS 即停。匹配下沉到遍历里
 * （而不是先收集全部文件再匹配），所以上限卡在「匹配数」不是「扫描数」，深目录也不会漏。
 */
async function walkAndMatch(
  searchRoot: string,
  baseDir: string,
  regex: RegExp,
  matched: string[],
): Promise<void> {
  if (matched.length >= _MAX_RESULTS) {
    return;
  }
  const entries = await readdir(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (matched.length >= _MAX_RESULTS) {
      return;
    }
    const full = path.join(baseDir, entry.name);
    if (entry.isDirectory()) {
      if (_SKIP_DIRS.has(entry.name)) {
        continue;
      }
      await walkAndMatch(searchRoot, full, regex, matched);
    } else {
      // 匹配「相对搜索根」的路径（用 / 分隔，跨平台统一）
      const rel = path.relative(searchRoot, full).split(path.sep).join("/");
      if (regex.test(rel)) {
        matched.push(full);
      }
    }
  }
}

export const globTool = tool(
  async ({ pattern, path: searchPath }: { pattern: string; path?: string | null }) => {
    // 搜索根：不传则用项目根目录（传 "." 锚定到 PROJECT_ROOT）
    const base = searchPath ? searchPath : ".";
    logger.info(`glob 查找: pattern=${pattern} base=${base}`);

    // 鉴权：搜索根必须在 PROJECT_ROOT 子树内
    const auth = authorizePath(base);
    if (!auth.ok) {
      logger.warning(auth.reason);
      return `(${auth.reason})`;
    }

    try {
      const regex = globToRegExp(pattern);
      const matched: string[] = [];
      await walkAndMatch(auth.abs, auth.abs, regex, matched);

      if (matched.length === 0) {
        return `(没有匹配 ${pattern} 的文件)`;
      }
      let body = matched.join("\n");
      if (matched.length >= _MAX_RESULTS) {
        body += `\n\n(匹配过多，仅显示前 ${_MAX_RESULTS} 个)`;
      }
      return body;
    } catch (exc) {
      logger.error(`glob 查找失败: ${String(exc)}`);
      return `(glob 查找失败: ${String(exc)})`;
    }
  },
  {
    name: "glob",
    description:
      "按通配符模式递归查找文件，返回匹配到的文件绝对路径列表。" +
      "当你想知道某种文件分布在哪、或按名字模式定位文件时调用（和 list_dir 互补）。" +
      "参数 pattern：通配符，支持 ** (任意层级)、* (单层任意)、? (单个字符)，如 **/*.ts；" +
      "可选 path：搜索的根目录（默认项目根目录），不需要就传 null。" +
      `最多返回 ${_MAX_RESULTS} 个文件。`,
    // 只读遍历目录，无副作用，风险低
    metadata: { risk: "low" },
    schema: z.object({
      pattern: z
        .string()
        .describe("通配符模式，如 **/*.ts；支持 **、*、?"),
      // OpenAI 兼容的 function-calling 要求可选字段同时 nullable，否则后端报错
      path: z
        .string()
        .nullable()
        .optional()
        .describe("搜索的根目录，默认项目根目录；不需要就传 null"),
    }),
  },
);
