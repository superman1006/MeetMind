import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// /api 与 /events 代理到 runtime(3002)。SSE 经 http-proxy 流式透传,无需额外配置。
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://localhost:3002", changeOrigin: true },
      "/events": { target: "http://localhost:3002", changeOrigin: true },
    },
  },
});
