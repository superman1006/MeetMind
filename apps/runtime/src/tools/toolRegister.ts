/**
 * 全局工具登记表（单例）+ 本地工具登记。
 *
 * 每个工具是 `src/tools/<xxx>Tool.ts` 导出的一个 LangChain `tool()` 单例；这里手动 import、
 * 逐个 register 成一个数组。新增本地工具 = 新建一个文件 + 在这里加一行 import + 一行 register。
 *
 * 本地工具在本模块加载时**同步**登记；MCP 工具（web 搜索等）由 bootstrap 阶段调用
 * `initMcpTools()` **异步**登记进同一个 `toolRegister` 实例。时序上 BaseAgent 在 buildGraph
 * （晚于 bootstrap）才构造、那时才 `bindTools(allTools)`，所以异步登记进来的 MCP 工具也能被看到。
 *
 * 关键：`allTools` 与 `toolRegister.allTools` 是**同一个数组引用**——`register()` 是原地 push，
 * 所以 bootstrap 里后登记的工具，持有 `allTools` 引用的 base.ts 同样能看到。
 */

import type { StructuredToolInterface } from "@langchain/core/tools";

import { ragSearchTool } from "./ragSearchTool.js";
import { echoTool } from "./echoTool.js";
import { processTool } from "./processTool.js";
import { listDirTool } from "./listDirTool.js";
import { readFileTool } from "./readFileTool.js";
import { fileEditTool } from "./fileEditTool.js";
import { webFetchTool } from "./webFetchTool.js";
import { grepTool } from "./grepTool.js";
import { globTool } from "./globTool.js";
import { writeFileTool } from "./writeFileTool.js";

/** 工具登记表：register(tool) 往 allTools 数组里 push。 */
export class ToolRegister {
  public allTools: StructuredToolInterface[] = [];
  register(tool: StructuredToolInterface): void {
    this.allTools.push(tool);
  }
}

export const toolRegister = new ToolRegister();

// ---- 本地工具：模块加载时同步登记 ----
toolRegister.register(ragSearchTool);
toolRegister.register(echoTool);
toolRegister.register(processTool);
toolRegister.register(listDirTool);
toolRegister.register(readFileTool);
toolRegister.register(fileEditTool);
toolRegister.register(webFetchTool);
toolRegister.register(grepTool);
toolRegister.register(globTool);
toolRegister.register(writeFileTool);

// 与 toolRegister.allTools 同引用；MCP 工具稍后由 initMcpTools() 追加进这同一个数组。
export const allTools = toolRegister.allTools;
