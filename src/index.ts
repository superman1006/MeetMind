/**
 * 进程入口。
 *
 * 直接运行:
 *   pnpm dev
 *
 * 或:
 *   pnpm start
 *
 * 这里只做一件事：保证 dotenv 已加载，再动态 import 主逻辑。
 * 对标 Python 端根目录 main.py 中的 `load_dotenv()` 顺序约束
 * （LangSmith 等 SDK 在 import 时就读 os.environ，所以要先 load）。
 */

import { config } from "dotenv";

// 相当于 python 的 load_dotenv()，把 .env 文件里的环境变量加载到 process.env 中。
// 只是在 ts 中是 config 函数就是把.env 读进来，而不是直接放在全局作用域里。
config();

const { main } = await import("./cli/main.js");
await main();
