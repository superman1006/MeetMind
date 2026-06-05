import { describe, it, expect } from "vitest";
import { groupSessionsByTime } from "./sessionGroups.js";
import type { SessionMeta } from "../stores/sessions.js";

// 固定一个「现在」当基准,所有用例都相对它构造 created_at,避免依赖真实时钟。
const NOW = new Date("2026-06-05T12:00:00Z").getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// 小工具:造一条会话,created_at 距 NOW 往前 ageMs 毫秒。
function makeSession(id: string, ageMs: number): SessionMeta {
  const createdAt = new Date(NOW - ageMs).toISOString();
  return { id, title: id, created_at: createdAt };
}

describe("groupSessionsByTime", () => {
  it("按 4 个时间段 + 更早 分桶,空桶不出现", () => {
    const list: SessionMeta[] = [
      makeSession("h", 30 * 60 * 1000), // 30 分钟 → 1 小时之前
      makeSession("d", 5 * HOUR), // 5 小时 → 1 天之前
      makeSession("3d", 2 * DAY), // 2 天 → 3 天之前
      makeSession("30d", 10 * DAY), // 10 天 → 30 天之前
      makeSession("old", 40 * DAY), // 40 天 → 更早
    ];
    const groups = groupSessionsByTime(list, NOW);
    const labels = groups.map((g) => g.label);
    expect(labels).toEqual(["1 小时之前", "1 天之前", "3 天之前", "30 天之前", "更早"]);
  });

  it("空桶被省略,只保留有内容的段", () => {
    const list: SessionMeta[] = [makeSession("a", 10 * 60 * 1000), makeSession("b", 50 * DAY)];
    const groups = groupSessionsByTime(list, NOW);
    const labels = groups.map((g) => g.label);
    expect(labels).toEqual(["1 小时之前", "更早"]);
  });

  it("同一桶内保持入参顺序(服务端已按 created_at DESC 给)", () => {
    const list: SessionMeta[] = [makeSession("newer", 10 * 60 * 1000), makeSession("older", 40 * 60 * 1000)];
    const groups = groupSessionsByTime(list, NOW);
    expect(groups).toHaveLength(1);
    const ids = groups[0].sessions.map((s) => s.id);
    expect(ids).toEqual(["newer", "older"]);
  });

  it("边界:正好 1 小时归入「1 天之前」,正好 1 天归入「3 天之前」", () => {
    const list: SessionMeta[] = [makeSession("at1h", HOUR), makeSession("at1d", DAY)];
    const groups = groupSessionsByTime(list, NOW);
    const byLabel: Record<string, string[]> = {};
    for (const g of groups) {
      byLabel[g.label] = g.sessions.map((s) => s.id);
    }
    expect(byLabel["1 天之前"]).toEqual(["at1h"]);
    expect(byLabel["3 天之前"]).toEqual(["at1d"]);
  });

  it("缺失 / 不可解析的 created_at 视为「现在」,落进最新桶", () => {
    const list: SessionMeta[] = [
      { id: "nocreated", title: "刚建的" },
      { id: "bad", title: "脏数据", created_at: "not-a-date" },
    ];
    const groups = groupSessionsByTime(list, NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("1 小时之前");
    const ids = groups[0].sessions.map((s) => s.id);
    expect(ids).toEqual(["nocreated", "bad"]);
  });

  it("空列表返回空数组", () => {
    expect(groupSessionsByTime([], NOW)).toEqual([]);
  });
});
