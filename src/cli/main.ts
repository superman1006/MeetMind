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

import { AGENT_NAMES, ROLE_DESCRIPTIONS } from "../config/constants.js";
import { getSettings } from "../config/settings.js";
import {
  countDocs,
  pingDb,
} from "../database/client.js";
import { getEmbedderModel } from "../database/embedding.js";
import { buildAgentsIndices } from "../database/initializer.js";
import { buildGraph } from "../graph/builder.js";
import type { AgentState, MessageTurn } from "../graph/state.js";
import {
  formatSeparator,
  printBanner,
  printMessagesTable,
  printSystem,
} from "../utils/formatting.js";
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

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
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

async function runOneDiscussion(
  graph: ReturnType<typeof buildGraph>,
  requirement: string,
): Promise<AgentState> {
  const initialState: AgentState = {
    requirement,
    messages: [],
    next_agent: null,
    done: false,
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

function printRoundReview(state: AgentState): void {
  const msgs = state.messages ?? [];
  const nTurns = msgs.length;
  const done = state.done ?? false;
  const doneText = done
    ? chalk.bold.green("架构师已宣布完成")
    : chalk.yellow("架构师未宣布完成");

  console.log(
    `\n${chalk.bold("[架构师复盘]")}  本轮共 ${nTurns} 次 agent 发言；${doneText}`,
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

  const rows = messages.map((m: MessageTurn, i: number) => {
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

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  let lastState: AgentState | null = null;

  try {
    while (true) {
      console.log();
      console.log(chalk.bold.magenta("架构师，请输入项目需求 (输入 'quit' 退出):"));
      let requirement: string;
      try {
        requirement = (await rl.question("> ")).trim();
      } catch {
        console.log(chalk.bold("\n再见！"));
        printFinalState(lastState);
        return;
      }

      if (!requirement) {
        continue;
      }
      // quit / exit / q 退出主循环
      const low = requirement.toLowerCase();
      if (low === "quit" || low === "exit" || low === "q") {
        console.log(chalk.bold("\n再见！"));
        printFinalState(lastState);
        return;
      }

      const finalState = await runOneDiscussion(graph, requirement);
      lastState = finalState;

      printRoundReview(finalState);
    }
  } finally {
    rl.close();
    logger.debug("CLI 主循环结束");
  }
}
