import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      // 覆盖率门槛只 gate「已写测试的核心模块」。LLM / embedding / rerank / HTTP / CLI
      // 等重 IO 模块暂不纳入门槛(见 docs 测试计划),避免门槛因不可单测的副作用代码而失真。
      include: [
        "src/graph/route.ts",
        "src/utils/utils.ts",
        "src/config/constants.ts",
        "src/config/settings.ts",
        "src/database/constants.ts",
        "src/database/splitters.ts",
        "src/database/chatStore.ts",
        "src/server/rpc.ts",
      ],
      thresholds: {
        // perFile:每个被 gate 的文件都要单独达标,而非只看聚合平均(更接近公司门槛)
        perFile: true,
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70,
      },
    },
  },
});
