/**
 * 全局工具登记表（单例）。
 *
 * 本地工具在本模块加载时**同步**登记；MCP 工具（web 搜索等）由 bootstrap 阶段调用
 * `initMcpTools()` **异步**登记进同一个 `toolRegister` 实例。时序上 BaseAgent 在
 * buildGraph（晚于 bootstrap）才构造、那时才 `bindTools(allTools)`，所以异步登记进来的
 * MCP 工具一样能被 agent 看到。
 *
 * 关键：`allTools` 与 `toolRegister.allTools` 是**同一个数组引用**——`register()` 是原地
 * push，所以 bootstrap 里后登记的工具，持有 `allTools` 引用的 base.ts 也能看到。
 */

import { ToolRegister } from "./toolRegistry.js";
import { ragSearchTool } from "./ragSearchTool.js";
import { echoTool } from "./echoTool.js";
import { processTool } from "./processTool.js";
import { listDirTool } from "./listDirTool.js";
import { readFileTool } from "./readFileTool.js";

export const toolRegister = new ToolRegister();

// ---- 本地工具：模块加载时同步登记 ----
toolRegister.register(ragSearchTool);
toolRegister.register(echoTool);
toolRegister.register(processTool);
toolRegister.register(listDirTool);
toolRegister.register(readFileTool);

// 与 toolRegister.allTools 同引用；MCP 工具稍后由 initMcpTools() 追加进这同一个数组。
export const allTools = toolRegister.allTools;
