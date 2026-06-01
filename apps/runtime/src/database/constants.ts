/**
 * 数据库层常量。
 */

import { getSettings } from "../config/settings.js";

/**
 * 返回某 agent 在 PostgreSQL 中的表名（`<prefix>_<agent>`）。
 *
 * 1 个 agent ↔ 1 张表，类比旧 ES 版本的「一个 index」。
 * 表名只由内部受控的 prefix + 固定 agent 名拼成，均为合法标识符，可安全用于 SQL。
 */
export function getTableName(agentName: string): string {
  return `${getSettings().pgTablePrefix}_${agentName}`;
}
