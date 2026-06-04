import { describe, it, expect, vi } from "vitest";

// 表名 = `<prefix>_<agent>`;mock 掉 settings 让 prefix 固定,不读 .env。
vi.mock("../../config/settings.js", () => ({
  getSettings: () => ({ pgTablePrefix: "meetmind" }),
}));

import { getTableName } from "./constants.js";

describe("getTableName", () => {
  it("用受控 prefix 拼出每个 agent 的表名", () => {
    expect(getTableName("architect")).toBe("meetmind_architect");
    expect(getTableName("backend")).toBe("meetmind_backend");
    expect(getTableName("pm")).toBe("meetmind_pm");
  });

  it("sessions / messages 这类非 agent 名也照样拼", () => {
    expect(getTableName("sessions")).toBe("meetmind_sessions");
  });
});
