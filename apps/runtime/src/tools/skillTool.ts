/**
 * skill 工具：按名字读取 `skills/` 下的某个技能（SKILL.md），把正文返回到上下文。
 *
 * 仿照 Claude Code 的 SkillTool，但刻意做成极简版：不 fork 子 agent、不做权限分级，
 * 只是「读文件 → 返回内容」。和 agent 无关，普通单例，所有 agent 共用（team 与 chat 两条
 * 路由分支的 agent 都通过 base.ts 的 bindTools(allTools) 拿到它）。
 *
 * 技能目录约定（锚定 src/skills，与 tools 同级）：
 *   - skills/<name>/SKILL.md   （推荐，带 frontmatter 的 Claude Code 风格）
 *   - skills/<name>.md         （单文件）
 *
 * description 里展示的「现存技能清单」在**模块加载时（启动时）**扫一次 skills/ 得到，
 * 不写死；新增技能后重启进程即可被 LLM 看到。
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { getLogger } from "../utils/logger.js";

const logger = getLogger("tools.skill");

// 本文件在 src/tools/ 下，技能目录在 src/skills/（与 tools 同级），故上跳一级再进 skills。
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 技能根目录：src/skills，与 tools 同级。 */
const SKILLS_DIR = path.resolve(__dirname, "..", "skills");

/** 一个技能的元信息：名字 + 一句话描述 + 正文文件绝对路径。 */
export interface SkillEntry {
  name: string;
  description: string;
  file: string;
}

/**
 * 从 SKILL.md 的 frontmatter 里抠出 `description:`（没有就退而取 `name:`）。
 * 只做最朴素的逐行解析：识别开头的 `---` 块，取第一处 `key: value`。
 */
function parseFrontmatterDescription(content: string): string {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== "---") {
    return "";
  }
  let description = "";
  let nameFallback = "";
  // 从第 2 行开始扫，遇到第二个 `---` 结束
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "---") {
      break;
    }
    if (line.startsWith("description:")) {
      description = line.slice("description:".length).trim();
    } else if (line.startsWith("name:")) {
      nameFallback = line.slice("name:".length).trim();
    }
  }
  if (description) {
    return description;
  }
  return nameFallback;
}

/**
 * 扫一遍 skills/，得到所有技能的元信息。
 * 同时支持 `skills/<name>/SKILL.md` 和 `skills/<name>.md` 两种布局。
 */
function scanSkills(): SkillEntry[] {
  const entries: SkillEntry[] = [];
  if (!existsSync(SKILLS_DIR)) {
    return entries;
  }

  let dirents;
  try {
    dirents = readdirSync(SKILLS_DIR, { withFileTypes: true });
  } catch (exc) {
    logger.warning(`扫描 skills/ 失败: ${String(exc)}`);
    return entries;
  }

  for (const dirent of dirents) {
    let skillName = "";
    let skillFile = "";

    if (dirent.isDirectory()) {
      // skills/<name>/SKILL.md
      const candidate = path.join(SKILLS_DIR, dirent.name, "SKILL.md");
      if (!existsSync(candidate)) {
        continue;
      }
      skillName = dirent.name;
      skillFile = candidate;
    } else if (dirent.isFile() && dirent.name.endsWith(".md")) {
      // skills/<name>.md（排除目录里的 SKILL.md 不会进到这里）
      skillName = dirent.name.slice(0, -".md".length);
      skillFile = path.join(SKILLS_DIR, dirent.name);
    } else {
      continue;
    }

    let description = "";
    try {
      const content = readFileSync(skillFile, "utf8");
      description = parseFrontmatterDescription(content);
    } catch (exc) {
      logger.warning(`读取技能 ${skillName} 失败: ${String(exc)}`);
    }

    entries.push({ name: skillName, description, file: skillFile });
    logger.info(`已加载 skill: ${skillName}`);
  }

  logger.info(`skill 加载完成，共 ${entries.length} 个`);
  return entries;
}

/** 启动时扫一次，缓存技能清单（description 与 call 都用它，避免重复扫盘）。 */
const SKILL_ENTRIES: SkillEntry[] = scanSkills();

/** 暴露已扫到的技能清单，供 bootstrap 启动时打印（与 MCP 工具加载日志同形态）。 */
export function getLoadedSkills(): SkillEntry[] {
  return SKILL_ENTRIES;
}

/** 把技能清单拼成给 LLM 看的一段文本：每行「- name：description」。 */
function renderSkillCatalog(entries: SkillEntry[]): string {
  if (entries.length === 0) {
    return "（当前 skills/ 目录为空或不存在，暂无可用技能）";
  }
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.description) {
      lines.push(`- ${entry.name}：${entry.description}`);
    } else {
      lines.push(`- ${entry.name}`);
    }
  }
  return lines.join("\n");
}

const description =
  "按名字读取 skills/ 下的某个技能并把其完整内容返回到上下文，供你照着执行。" +
  "当你判断某个现存技能与当前任务相关时调用，参数 skill 传技能名。" +
  "现存技能：\n" +
  renderSkillCatalog(SKILL_ENTRIES);

export const skillTool = tool(
  async ({ skill }: { skill: string }) => {
    const wanted = skill.trim();
    if (!wanted) {
      return "(技能名为空)";
    }

    // 在已缓存的清单里按名字找；找不到就把可用技能名列出来提示 LLM
    let matched: SkillEntry | undefined = undefined;
    for (const entry of SKILL_ENTRIES) {
      if (entry.name === wanted) {
        matched = entry;
        break;
      }
    }
    if (!matched) {
      const names: string[] = [];
      for (const entry of SKILL_ENTRIES) {
        names.push(entry.name);
      }
      const available = names.length > 0 ? names.join(", ") : "（无）";
      return `(未找到技能 "${wanted}"，可用技能：${available})`;
    }

    try {
      const content = readFileSync(matched.file, "utf8");
      return content;
    } catch (exc) {
      return `(读取技能 "${wanted}" 失败: ${String(exc)})`;
    }
  },
  {
    name: "skill",
    description,
    // 只读 skills/ 下的文本文件，无副作用，风险低
    metadata: { risk: "low" },
    schema: z.object({
      skill: z.string().describe("要加载的技能名（skills/ 下的目录名或 .md 文件名，不含后缀）"),
    }),
  },
);
