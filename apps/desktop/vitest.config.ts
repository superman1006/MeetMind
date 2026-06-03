import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

// 前端测试:happy-dom 提供 DOM / localStorage 等浏览器全局;本轮只测逻辑层
// (stores / api / 纯工具),不做 Vue 组件渲染测试。组件测试以后要做再加 @vue/test-utils。
export default defineConfig({
  plugins: [vue()],
  test: {
    include: ["src/**/*.test.ts"],
    environment: "happy-dom",
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      // 门槛只 gate 已测的逻辑层模块;组件(.vue)与入口 main.ts 暂不纳入。
      include: [
        "src/stores/chat.ts",
        "src/stores/sessions.ts",
        "src/stores/ui.ts",
        "src/theme/agentColors.ts",
        "src/api/rpcClient.ts",
        "src/api/sseClient.ts",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70,
      },
    },
  },
});
