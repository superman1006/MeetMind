import { describe, it, expect, beforeEach } from "vitest";
import { isBusy, setBusy } from "../sessions.js";

describe("sessions(busy 标记)", () => {
  beforeEach(() => {
    setBusy("s1", false);
  });

  it("默认未 busy", () => {
    expect(isBusy("nope")).toBe(false);
  });

  it("busy 标记可置位/清位", () => {
    expect(isBusy("s1")).toBe(false);
    setBusy("s1", true);
    expect(isBusy("s1")).toBe(true);
    setBusy("s1", false);
    expect(isBusy("s1")).toBe(false);
  });
});
