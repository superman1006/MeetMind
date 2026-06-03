import { describe, it, expect, vi } from "vitest";
import path from "node:path";

import {
  cleanBadChars,
  formatSeparator,
  pathExists,
  colorize,
  printAgentInfo,
  printSystem,
  printBanner,
  printMessagesTable,
} from "./utils.js";

describe("cleanBadChars", () => {
  it("空串原样返回", () => {
    expect(cleanBadChars("")).toBe("");
  });

  it("普通文本(含中文)不变", () => {
    expect(cleanBadChars("hello 世界")).toBe("hello 世界");
  });

  it("合法代理对(emoji)完整保留", () => {
    expect(cleanBadChars("a😀b")).toBe("a😀b");
    expect(cleanBadChars("😀")).toBe("😀");
  });

  it("孤立 high surrogate → ?", () => {
    const loneHigh = "a" + String.fromCharCode(0xd800) + "b";
    expect(cleanBadChars(loneHigh)).toBe("a?b");
  });

  it("结尾的孤立 high surrogate(后面没字符)→ ?", () => {
    const trailingHigh = "a" + String.fromCharCode(0xd800);
    expect(cleanBadChars(trailingHigh)).toBe("a?");
  });

  it("孤立 low surrogate → ?", () => {
    const loneLow = "x" + String.fromCharCode(0xdc00);
    expect(cleanBadChars(loneLow)).toBe("x?");
  });
});

describe("formatSeparator", () => {
  it("无标题:整行同一个字符,长度=width", () => {
    expect(formatSeparator()).toBe("=".repeat(70));
    expect(formatSeparator("", "-", 10)).toBe("-".repeat(10));
  });

  it("带标题:标题居中,两侧用填充字符,总长=width", () => {
    const line = formatSeparator("hi", "*", 20);
    expect(line).toContain(" hi ");
    expect(line.startsWith("*")).toBe(true);
    expect(line.length).toBe(20);
  });
});

describe("pathExists", () => {
  it("存在的目录 → true", async () => {
    expect(await pathExists(process.cwd())).toBe(true);
  });

  it("不存在的路径 → false", async () => {
    const missing = path.join(process.cwd(), "definitely-not-here-12345.tmp");
    expect(await pathExists(missing)).toBe(false);
  });
});

describe("colorize", () => {
  it("每个角色(含 default)都返回一个能套字符串的函数", () => {
    for (const role of ["architect", "backend", "frontend", "tester", "pm", "其它"]) {
      const fn = colorize(role);
      expect(typeof fn).toBe("function");
      expect(typeof fn("x")).toBe("string");
    }
  });
});

describe("CLI 打印函数(冒烟:执行不抛错)", () => {
  it("printSystem / printBanner / printAgentInfo / printMessagesTable 均可执行", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    printSystem("系统提示");
    printBanner("标题", "副标题");
    printBanner("只有标题");
    // 遍历每个已知角色:覆盖 ROLE_COLORS 里每个配色闭包 + footer(usedRag + nextRole)分支
    for (const role of ["architect", "backend", "frontend", "tester", "pm", "system"]) {
      printAgentInfo({ agentName: role, message: `${role} 的发言`, nextRole: "架构师", usedRag: true });
    }
    // 未知角色 → 走 fallback 配色;无 footer 分支
    printAgentInfo({ agentName: "unknown", message: "hi" });
    printMessagesTable([
      { index: 0, agentName: "pm", nextRole: null, preview: "需求拆解" },
      { index: 1, agentName: "backend", nextRole: "architect", preview: "接口设计" },
    ]);
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
