import { describe, it, expect } from "vitest";
import path from "node:path";

import { getSettings, settingFieldNames, PROJECT_ROOT } from "./settings.js";

describe("config/settings", () => {
  it("getSettings 返回配置对象,且是缓存单例(两次同一引用)", () => {
    const s1 = getSettings();
    const s2 = getSettings();
    expect(s1).toBe(s2);
    expect(typeof s1.maxIterations).toBe("number");
    expect(typeof s1.pgUrl).toBe("string");
    expect(s1.pgTablePrefix.length).toBeGreaterThan(0);
  });

  it("相对路径字段被 resolveRel 锚定成 PROJECT_ROOT 下的绝对路径", () => {
    const s = getSettings();
    expect(path.isAbsolute(s.seedDataPath)).toBe(true);
    expect(path.isAbsolute(s.embeddingCacheDir)).toBe(true);
    expect(s.seedDataPath.startsWith(PROJECT_ROOT)).toBe(true);
    expect(s.embeddingCacheDir.startsWith(PROJECT_ROOT)).toBe(true);
  });

  it("数值字段经 zod coerce 成 number", () => {
    const s = getSettings();
    expect(Number.isFinite(s.maxIterations)).toBe(true);
    expect(Number.isFinite(s.retrieveTopN)).toBe(true);
    expect(Number.isFinite(s.rerankTopN)).toBe(true);
  });

  it("settingFieldNames 含全部关键字段名", () => {
    const names = settingFieldNames();
    for (const k of ["apiKey", "baseUrl", "pgUrl", "maxIterations", "seedDataPath", "rerankTopN"]) {
      expect(names).toContain(k);
    }
  });
});
