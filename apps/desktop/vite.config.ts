import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// /api 与 /events 代理到 runtime(3002)。SSE 经 http-proxy 流式透传,无需额外配置。
const runtimeOrigin = process.env.MEETMIND_RUNTIME_ORIGIN || "http://localhost:3002";

export default defineConfig({
  plugins: [vue()],
  server: {
    // 显式绑 IPv4 回环。默认 host: "localhost" 时 Node 的 dns.lookup 先返回 ::1,
    // Vite 会只监听 [::1]:5173,浏览器按 127.0.0.1 访问就是 ERR_CONNECTION_REFUSED。
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: runtimeOrigin, changeOrigin: true },
      "/events": { target: runtimeOrigin, changeOrigin: true },
    },
  },
});
