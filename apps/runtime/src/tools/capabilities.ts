/**
 * 账号默认能力目录：新账号创建时默认勾选当前全部可用工具与 skills。
 *
 * 工具按账号权限筛选（运维类工具仅 admin 可见），skills 取启动时扫到的全部技能。
 * 结果只在创建账号时快照一次；之后新增工具或技能不会自动改写已有账号的勾选。
 */

import { getMeetingTools } from "./meetingTools.js";
import { getLoadedSkills } from "./skillTool.js";

export interface DefaultCapabilities {
  tools: string[];
  skills: string[];
}

export function getDefaultCapabilities(username: string): DefaultCapabilities {
  const tools: string[] = [];
  for (const entry of getMeetingTools(username)) {
    tools.push(entry.name);
  }

  const skills: string[] = [];
  for (const entry of getLoadedSkills()) {
    skills.push(entry.name);
  }

  return { tools, skills };
}
