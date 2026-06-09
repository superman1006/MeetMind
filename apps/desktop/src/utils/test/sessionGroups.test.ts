import { describe, it, expect } from "vitest";
import { groupSessionsByTime } from "../sessionGroups.js";
import type { SessionMeta } from "../../stores/sessions.js";

// 固定一个「现在」当基准:本地时间 2026-06-05 12:00。用本地构造(而非 UTC 字符串)
// 是因为「今天 / 昨天」按本地自然日切分,UTC 基准会随运行机器的时区漂移。
const NOW = new Date(2026, 5, 5, 12, 0, 0).getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// 小工具:造一条会话,created_at 取某个 epoch 毫秒。
function sessionAt(id: string, ms: number): SessionMeta {
  return { id, title: id, created_at: new Date(ms).toISOString() };
}

describe("groupSessionsByTime", () => {
  it("按 今天/昨天/7天内/30天内/更早 分桶,空桶不出现", () => {
    const list: SessionMeta[] = [
      sessionAt("today", NOW - 2 * HOUR), // 今早 10 点 → 今天
      sessionAt("yday", new Date(2026, 5, 4, 20, 0, 0).getTime()), // 昨晚 8 点 → 昨天
      sessionAt("w", NOW - 4 * DAY), // 4 天前 → 7 天内
      sessionAt("m", NOW - 20 * DAY), // 20 天前 → 30 天内
      sessionAt("old", NOW - 40 * DAY), // 40 天前 → 更早
    ];
    const groups = groupSessionsByTime(list, NOW);
    const labels = groups.map((g) => g.label);
    expect(labels).toEqual(["今天", "昨天", "7 天内", "30 天内", "更早"]);
  });

  it("空桶被省略,只保留有内容的段", () => {
    const list: SessionMeta[] = [sessionAt("a", NOW - 1 * HOUR), sessionAt("b", NOW - 50 * DAY)];
    const groups = groupSessionsByTime(list, NOW);
    const labels = groups.map((g) => g.label);
    expect(labels).toEqual(["今天", "更早"]);
  });

  it("同一桶内保持入参顺序(服务端已按 created_at DESC 给)", () => {
    const list: SessionMeta[] = [sessionAt("newer", NOW - 1 * HOUR), sessionAt("older", NOW - 3 * HOUR)];
    const groups = groupSessionsByTime(list, NOW);
    expect(groups).toHaveLength(1);
    const ids = groups[0].sessions.map((s) => s.id);
    expect(ids).toEqual(["newer", "older"]);
  });

  it("今天/昨天按本地自然日切分:昨晚 11 点算昨天,今晨 1 点算今天", () => {
    const list: SessionMeta[] = [
      sessionAt("lateToday", new Date(2026, 5, 5, 1, 0, 0).getTime()), // 今晨 1 点(距今 11 小时) → 今天
      sessionAt("lastNight", new Date(2026, 5, 4, 23, 0, 0).getTime()), // 昨晚 11 点(距今 13 小时) → 昨天
    ];
    const groups = groupSessionsByTime(list, NOW);
    const byLabel: Record<string, string[]> = {};
    for (const g of groups) {
      byLabel[g.label] = g.sessions.map((s) => s.id);
    }
    expect(byLabel["今天"]).toEqual(["lateToday"]);
    expect(byLabel["昨天"]).toEqual(["lastNight"]);
  });

  it("上周(~7 天前)的会话落进「7 天内」而不是「30 天内」", () => {
    const list: SessionMeta[] = [sessionAt("lastWeek", NOW - 6 * DAY)];
    const groups = groupSessionsByTime(list, NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("7 天内");
  });

  it("缺失 / 不可解析的 created_at 视为「现在」,落进「今天」", () => {
    const list: SessionMeta[] = [
      { id: "nocreated", title: "刚建的" },
      { id: "bad", title: "脏数据", created_at: "not-a-date" },
    ];
    const groups = groupSessionsByTime(list, NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("今天");
    const ids = groups[0].sessions.map((s) => s.id);
    expect(ids).toEqual(["nocreated", "bad"]);
  });

  it("空列表返回空数组", () => {
    expect(groupSessionsByTime([], NOW)).toEqual([]);
  });
});
