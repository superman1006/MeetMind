import path from "node:path";
import { lstat } from "node:fs/promises";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { PROJECT_ROOT } from "../config/settings.js";
import { isMeetingSourceEntry } from "./pathAuth.js";
import { allTools } from "./toolRegister.js";

const fileArguments: Readonly<Record<string, string>> = {
  Read: "file_path", Edit: "file_path", Write: "file_path",
  list_dir: "path", grep: "path", glob: "path",
};
const operatorTools = new Set(["list_processes", "web_fetch", "Edit", "Write"]);
const sourceRoots = new Set(["apps", "docs", "deploy"]);
const rootFiles = new Set(["README.md", "README.zh-CN.md", "package.json", "pnpm-workspace.yaml", "docker-compose.yml", "AGENTS.md"]);

// 从全局工具中选出会议可用项。运维类工具要求执行账号与主持人均为 admin。
export function getMeetingTools(username: string, host = username): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = [];
  for (const entry of allTools) {
    if (entry.name === "skill") continue;
    if (operatorTools.has(entry.name) && (username !== "admin" || host !== "admin")) continue;
    tools.push(entry);
  }
  return tools;
}

// 工具循环执行前调用此处，校验技能名单，并将文件类工具的路径限制在可访问的项目范围。
export async function meetingToolArguments(
  name: string, args: Record<string, unknown>, allowedSkills: Set<string>,
): Promise<Record<string, unknown> | null> {
  if (name === "skill" && (typeof args.skill !== "string" || !allowedSkills.has(args.skill))) return null;

  const field = fileArguments[name];
  if (!field) return args;
  const givenPath = args[field];
  const isSearch = name === "grep" || name === "glob";
  if (typeof givenPath !== "string" && !isSearch) return null;
  let absolutePath = path.resolve(PROJECT_ROOT, typeof givenPath === "string" ? givenPath : "apps");
  if (absolutePath === PROJECT_ROOT && isSearch) absolutePath = path.join(PROJECT_ROOT, "apps");
  if (absolutePath === PROJECT_ROOT && name === "list_dir") return { ...args, [field]: absolutePath };

  const relativePath = path.relative(PROJECT_ROOT, absolutePath);
  const segments = relativePath.split(path.sep);
  if (!sourceRoots.has(segments[0]) && !(segments.length === 1 && rootFiles.has(segments[0]))) return null;

  // 逐层检查路径，避免通过中间目录的符号链接跳出允许范围。
  let current = PROJECT_ROOT;
  for (const segment of segments) {
    if (!isMeetingSourceEntry(segment)) return null;
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (name !== "Write" && name !== "Edit") return null;
    }
  }
  return { ...args, [field]: absolutePath };
}
