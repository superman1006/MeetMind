/**
 * MeetMind 的交互式 CLI 入口。
 *
 * 流程：
 *   1. 打印 banner + 团队介绍
 *   2. bootstrap：PostgreSQL 健康检查 → 本地 rerank 模型信息 → LangSmith 状态 → 扫描种子目录 → 预热 embedding → 灌库
 *   3. 编译 LangGraph
 *   4. 主循环：用户输入需求 → 跑图 → 复盘 → 继续 / 退出
 */

import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

import chalk from "chalk";
import ora from "ora";

import { AGENT_NAMES, ARCHITECT, ROLE_DESCRIPTIONS } from "../config/constants.js";
import { getSettings } from "../config/settings.js";
import {
  countDocs,
  pingDb,
} from "../database/client.js";
import { getEmbedderModel } from "../database/embedding.js";
import { buildAgentsIndices } from "../database/initializer.js";
import type { AgentResponse } from "../agents/base.js";
import { buildGraph } from "../graph/builder.js";
import type { AgentState } from "../graph/state.js";
import {
  formatSeparator,
  pathExists,
  printBanner,
  printMessagesTable,
  printSystem,
} from "../utils/utils.js";
import { getLogger, setupLogging } from "../utils/logger.js";

const logger = getLogger("cli");

// 让 stdin 走 UTF-8，避免输入中文产生 surrogate 问题
process.stdin.setEncoding("utf8");

function printAppBanner(): void {
  printBanner(
    `${chalk.bold.cyan("MeetMind")}   多 Agent RAG 协作系统`,
    "架构师 → 后端 / 前端 / 测试 / 产品经理 — 基于 LangGraph + PostgreSQL",
  );
  console.log();
  console.log(chalk.bold("当前 Agent 团队:"));
  for (const [roleId, desc] of Object.entries(ROLE_DESCRIPTIONS)) {
    console.log(`  • ${chalk.bold(roleId.padEnd(10))} - ${desc}`);
  }
  console.log();
}

async function bootstrap(): Promise<void> {
  setupLogging();
  const settings = getSettings();

  console.log("=".repeat(40), "get_settings() 拿到配置", "=".repeat(40));
  for (const [k, v] of Object.entries(settings)) {
    let display: string;
    if (typeof v === "string" && v.length > 0 && /key|token/i.test(k)) {
      display = `${v.slice(0, 4)}***${v.slice(-2)}`;
    } else {
      display = String(v);
    }
    console.log(`配置项 ${k}=${display}`);
  }
  console.log("=".repeat(100));
  console.log();

  // ---------- PostgreSQL 健康检查 ----------
  // 连接串里可能含密码，打印时把 user:pass@ 段脱敏
  const safePgUrl = settings.pgUrl.replace(/\/\/[^@/]*@/, "//***@");
  printSystem(`PostgreSQL 地址: ${chalk.cyan(safePgUrl)}`);
  const pgOk = await pingDb(); // PostgreSQL 是硬依赖，连不上直接退
  if (!pgOk) {
    printSystem(
      chalk.bold.red("✗ 无法连接到 PostgreSQL") +
        "\n请先在项目根目录执行 " +
        chalk.bold("docker compose up -d") +
        " 启动本地 PostgreSQL（含 pgvector），或修改 .env 中的 PG_URL 指向已有实例。",
    );
    process.exit(1);
  }
  printSystem(chalk.green("✓ PostgreSQL 已就绪"));

  // ---------- 本地 Rerank 模型（cross-encoder，无需 key）----------
  printSystem(
    `本地 Rerank: ${chalk.cyan(settings.rerankModelName)}  ` +
      `(混合检索捞 ${chalk.bold(String(settings.retrieveTopN))} → rerank 取 ${chalk.bold(String(settings.rerankTopN))})`,
  );

  // ---------- LangSmith 追踪 ----------
  const langsmithOn = (process.env.LANGSMITH_TRACING ?? "").toLowerCase() === "true";
  if (langsmithOn) {
    const project = process.env.LANGSMITH_PROJECT ?? "default";
    printSystem(
      `LangSmith 追踪: ${chalk.bold.green("已启用")}  项目: ${chalk.cyan(project)}  ` +
        `→ https://smith.langchain.com/projects/p/${project}`,
    );
  } else {
    printSystem(
      "LangSmith 追踪: " +
        chalk.dim("未启用（在 .env 中设置 LANGSMITH_TRACING=true 可开启）"),
    );
  }

  // ---------- 扫描种子目录 ----------
  printSystem("扫描各 Agent 的 seed 文件目录：");
  for (const agent of AGENT_NAMES) {
    const dir = path.join(settings.seedDataPath, agent);
    if (!(await pathExists(dir))) {
      printSystem(
        `   · ${chalk.yellow(agent)}: (目录不存在，将走旧 *_seeds.json 兜底)`,
      );
      continue;
    }
    const entries = await readdir(dir);
    const fileNames: string[] = [];
    for (const name of entries) {
      if (name.startsWith(".")) {
        continue;
      }
      const s = await stat(path.join(dir, name));
      if (s.isFile()) {
        fileNames.push(name);
      }
    }
    fileNames.sort();
    if (fileNames.length === 0) {
      printSystem(`   · ${chalk.yellow(agent)}: 目录为空`);
    } else {
      printSystem(
        `   · ${chalk.cyan(agent)}: ${fileNames.length} 个文件 → ${fileNames.join(", ")}`,
      );
    }
  }
  console.log();

  // ---------- 预热 embedding ----------
  const spinner1 = ora({ text: chalk.bold.cyan("预热 embedding 模型 (~80MB)..."), spinner: "dots" }).start();
  try {
    await getEmbedderModel();
    spinner1.succeed(chalk.green("✓") + " embedding 模型已加载到内存");
  } catch (exc) {
    spinner1.fail("embedding 加载失败");
    throw exc;
  }

  // ---------- 灌库 ----------
  const spinner2 = ora({ text: chalk.bold.cyan("初始化 5 个 Agent 的 PostgreSQL 表..."), spinner: "dots" }).start();
  let added: Record<string, number>;
  try {
    added = await buildAgentsIndices();
    spinner2.succeed("PostgreSQL 表初始化完成");
  } catch (exc) {
    spinner2.fail("PostgreSQL 表初始化失败");
    throw exc;
  }

  for (const agent of AGENT_NAMES) {
    const newCount = added[agent] ?? 0;
    const total = await countDocs(agent);
    const status = newCount > 0 ? `新增 ${chalk.bold.green(String(newCount))} 条，` : chalk.dim("无新增，");
    printSystem(`  ✓ ${chalk.bold(agent)}: ${status}表现共 ${total} 条文档`);
  }
}

async function runExecution(
    graph: ReturnType<typeof buildGraph>, //graph 的类型是 buildGraph() 的返回值类型，也就是编译后的 graph 实例
    currentRequirement: string,
    priorMessages: AgentResponse[], // 跨轮记忆：上一轮累计的全部发言，作为本轮 messages 的起点
): Promise<AgentState> {
  const initialState: AgentState = {
    requirement: currentRequirement,
    // 带入历史轮的 messages，concat reducer 会在其上继续追加本轮发言，
    // 于是 agent 的 history 里能看到之前所有讨论，最终展示也是全量。
    messages: priorMessages,
    next_agent: null,
    done: false,
    // iteration 每轮从 0 重置：安全阀针对「本轮」计数，不受历史轮影响
    iteration: 0,
  };

  console.log();
  const now = new Date();
  const hhmmss = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
  console.log(formatSeparator(`讨论开始: ${hhmmss}`));
  console.log();

  let finalState: AgentState = initialState;
  const stream = await graph.stream(initialState, {
    recursionLimit: 50, // 防失控的硬上限
    streamMode: "values",
  });
  // 每个节点跑完吐一次 state，留最后一帧
  for await (const state of stream) {
    finalState = state as AgentState;
  }

  console.log();
  console.log(formatSeparator("讨论结束"));
  console.log();
  return finalState;
}

function printRoundReview(state: AgentState, roundTurns: number): void {
  // messages 现在是跨轮累计的，所以「本轮发言数」要用增量 roundTurns，不能直接取 length
  const done = state.done ?? false;
  const doneText = done
    ? chalk.bold.green("架构师已宣布完成")
    : chalk.yellow("架构师未宣布完成");

  console.log(
    `\n${chalk.bold("[架构师复盘]")}  本轮共 ${roundTurns} 次 agent 发言；${doneText}`,
  );
}

function printFinalState(state: AgentState | null): void {
  if (state === null) {
    console.log("\n" + chalk.dim("(本次会话未进入任何讨论，无最终 AgentState 可展示。)"));
    return;
  }
  const messages = state.messages ?? [];
  console.log();
  if (messages.length === 0) {
    return;
  }

  const rows = messages.map((m: AgentResponse, i: number) => {
    const flat = (m.message ?? "").replace(/\n/g, " ");
    const preview = flat.length > 80 ? flat.slice(0, 80) + "..." : flat;
    return {
      index: i + 1,
      agentName: m.agent_name ?? "",
      nextRole: m.next_agent ?? null,
      preview,
    };
  });
  printMessagesTable(rows);
}



export async function main(): Promise<void> {
  printAppBanner();
  await bootstrap(); // 自检 + 灌库，任一失败直接退出

  const graph = buildGraph(); // 编译一次，整个会话复用

  printBanner(
    chalk.bold("使用说明"),
    "1. 架构师（你）输入需求；\n" +
      "2. 系统将自动驱动 5 个 agent 讨论，按结构化字段 next_agent 路由；\n" +
      "3. 架构师 agent 把 done 设为 true 后本轮结束，由你决定继续或退出。",
  );

  // 创建一个 readline,用来读取输入然后输出,只有在 CLI才会用到,实际开发中用  HTTP 输入请求 + SSE 输出响应 !!!!
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  let lastState: AgentState | null = null;

  try {
    while (true) {
      console.log();
      console.log(chalk.bold.magenta("架构师，请输入项目需求 (输入 'quit' 退出):"));
      let requirement: string;
      try {
        // 用 rl.question 让用户控制台输入需求，trim 去掉首尾空白
        requirement = (await rl.question("> ")).trim();
      } catch {
        console.log(chalk.bold("\n再见！"));
        printFinalState(lastState);
        return;
      }

      // 用户输入为空则继续
      if (!requirement) {
        continue;
      }

      // quit / exit / q 退出主循环
      const low = requirement.toLowerCase(); // 转小写
      if (low === "quit" || low === "exit" || low === "q") {
        console.log(chalk.bold("\n再见！"));
        printFinalState(lastState);
        return;
      }

      // 把本轮用户输入也作为一条 message 记进历史（agent_name=user），
      // 这样最终展示和 agent 的 history 里都能看到「用户提了什么」，而不只是 5 个 agent 的回复
      const userTurn: AgentResponse = {
        agent_name: "user",
        role: "用户",
        message: requirement,
        next_agent: ARCHITECT, // 用户之后由架构师接手
        done: false, // 用户这条不是完成信号
        used_rag: false, // 用户输入不涉及 RAG
      };

      // 上一轮累计的 messages + 本轮用户输入，一起作为本轮起点（跨轮记忆）；首轮 prior 为空
      const priorMessages = lastState?.messages ?? [];
      const seedMessages = [...priorMessages, userTurn];
      const currentState = await runExecution(graph, requirement, seedMessages);
      lastState = currentState;

      // 本轮新增 agent 发言数 = 累计 - 起点（起点已含用户那条），故不会把 user 算进去
      const roundTurns = (currentState.messages?.length ?? 0) - seedMessages.length;
      printRoundReview(currentState, roundTurns);
    }
  } finally {
    rl.close(); // 释放 readline
    logger.debug("CLI 主循环结束");
  }
}
