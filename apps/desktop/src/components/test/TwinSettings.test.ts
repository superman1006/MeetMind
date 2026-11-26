import { afterEach, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import { rpc } from "../../api/rpcClient.js";
import TwinSettings from "../TwinSettings.vue";

vi.mock("../../api/rpcClient.js", () => ({ rpc: vi.fn() }));

const container = document.createElement("div");
const app = createApp(TwinSettings);

afterEach(() => {
  app.unmount();
  container.remove();
});

it("按组全选当前目录，保留另一组勾选并随设置保存", async () => {
  const saved = {
    display_name: "Alice", persona: "", memory: "",
    tools: ["Read", "AIsearch"], skills: ["review"],
  };
  const catalog = {
    tools: [
      { name: "Read", description: "读取文件", risk: "low" },
      { name: "echo", description: "回显", risk: "low" },
    ],
    skills: [
      { name: "review", description: "审查代码" },
      { name: "design", description: "设计方案" },
    ],
  };
  const rpcMock = vi.mocked(rpc);
  rpcMock.mockResolvedValueOnce(saved);
  rpcMock.mockResolvedValueOnce(catalog);
  rpcMock.mockResolvedValueOnce({ ok: true });

  document.body.append(container);
  app.mount(container);
  const tabs = container.querySelectorAll<HTMLButtonElement>("nav button");
  const capabilitiesTab = Array.from(tabs).find((button) => button.textContent === "工具与 Skills");
  capabilitiesTab?.click();
  await vi.waitFor(() => expect(container.querySelectorAll("fieldset")).toHaveLength(2));

  const [toolGroup, skillGroup] = container.querySelectorAll("fieldset");
  const [read, echo] = toolGroup.querySelectorAll<HTMLInputElement>("input");
  const [review, design] = skillGroup.querySelectorAll<HTMLInputElement>("input");
  expect([read.checked, echo.checked, review.checked, design.checked]).toEqual([true, false, true, false]);

  const selectTools = toolGroup.querySelector("button");
  const selectSkills = skillGroup.querySelector("button");
  expect(selectTools?.textContent?.trim()).toBe("全选");
  expect(selectSkills?.textContent?.trim()).toBe("全选");

  selectTools?.click();
  await nextTick();
  expect([read.checked, echo.checked, review.checked, design.checked]).toEqual([true, true, true, false]);
  expect(selectTools?.disabled).toBe(true);

  selectSkills?.click();
  await nextTick();
  expect([read.checked, echo.checked, review.checked, design.checked]).toEqual([true, true, true, true]);
  expect(selectSkills?.disabled).toBe(true);

  const save = container.querySelector<HTMLButtonElement>("footer button");
  save?.click();
  expect(rpc).toHaveBeenLastCalledWith("twin.setProfile", {
    ...saved, tools: ["Read", "AIsearch", "echo"], skills: ["review", "design"],
  });
});
