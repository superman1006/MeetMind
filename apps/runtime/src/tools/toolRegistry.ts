/**
 * 工具登记表。
 *
 * 每个工具是 `src/tools/<xxx>Tool.ts` 里导出的一个 LangChain `Tool()` 单例；
 * 这里手动 import 它们、拼成一个数组。新增工具 = 新建一个文件 + 在这里加一行 import + 一项。
 *
 * BaseAgent 直接 `model.bindTools(allTools)`。
 */

import type { StructuredToolInterface } from "@langchain/core/tools";



export class ToolRegister{
    public allTools: StructuredToolInterface[] = [];
    /** 所有工具的清单。 */
    register(tool: StructuredToolInterface): void {
        this.allTools.push(tool)
    }
}
