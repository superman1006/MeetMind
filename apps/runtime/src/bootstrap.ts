/**
 * 启动自检 + 灌库:PostgreSQL 健康检查(失败 exit 1) → rerank 信息 → LangSmith 状态 →
 * 扫描种子目录 → 预热 embedding → 灌库。CLI 与 HTTP 服务共用。
 */
import path from "node:path";
import { readdir, stat } from "node:fs/promises";

import chalk from "chalk";
import ora from "ora";

import { AGENT_NAMES } from "./config/constants.js";
import { getSettings } from "./config/settings.js";
import { countDocs, pingDb } from "./database/client.js";
import { ensureChatTables } from "./database/chatStore.js";
import { getEmbedderModel } from "./database/embedding.js";
import { buildAgentsTables } from "./database/initializer.js";
import { pathExists, printSystem } from "./utils/utils.js";
import { setupLogging } from "./utils/logger.js";

export async function bootstrap(): Promise<void> {
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
  const safePgUrl = settings.pgUrl.replace(/\/\/[^@/]*@/, "//***@");
  printSystem(`PostgreSQL 地址: ${chalk.cyan(safePgUrl)}`);
  const pgOk = await pingDb();
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

  // ---------- 会话 / 消息表 ----------
  await ensureChatTables();
  printSystem(chalk.green("✓ 会话 / 消息表已就绪"));

  // ---------- 本地 Rerank ----------
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
    printSystem("LangSmith 追踪: " + chalk.dim("未启用（在 .env 中设置 LANGSMITH_TRACING=true 可开启）"));
  }

  // ---------- 扫描种子目录 ----------
  printSystem("扫描各 Agent 的 seed 文件目录：");
  for (const agent of AGENT_NAMES) {
    const dir = path.join(settings.seedDataPath, agent);
    if (!(await pathExists(dir))) {
      printSystem(`   · ${chalk.yellow(agent)}: (目录不存在，将走旧 *_seeds.json 兜底)`);
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
      printSystem(`   · ${chalk.cyan(agent)}: ${fileNames.length} 个文件 → ${fileNames.join(", ")}`);
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
    added = await buildAgentsTables();
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
