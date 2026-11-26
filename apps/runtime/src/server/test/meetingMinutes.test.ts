import { expect, it } from "vitest";
import { formatMeetingMinutes } from "../meetingMinutes.js";

it("纪要用会议创建时间命名，正文开头记录起止时间", () => {
  const result = formatMeetingMinutes(
    "abc",
    new Date("2026-11-24T09:02:03Z"),
    new Date("2026-11-24T09:18:04Z"),
    "确认了接口设计。",
  );

  expect(result.filename).toBe("2026-11-24_16-02-03_abc.md");
  expect(result.markdown.startsWith("会议时间：2026-11-24 16:02:03 — 2026-11-24 16:18:04")).toBe(true);
  expect(result.markdown).toContain("确认了接口设计。");
});
