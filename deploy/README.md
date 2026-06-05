# MeetMind 部署（Docker）

把 MeetMind 从「本地桌面应用」变成「别人浏览器输网址就能访问」的在线服务。
一套 compose 起三个容器：

| 服务 | 作用 | 镜像/构建 |
|---|---|---|
| `postgres` | RAG 存储 + pgvector 向量检索 | `pgvector/pgvector:pg17` |
| `runtime` | 后端（Node + tsx，HTTP/SSE，含本地 embedding/rerank 模型） | `Dockerfile.runtime` |
| `web` | 前端（Vite 构建产物 + Nginx，反代 `/api`、`/events`） | `Dockerfile.web` |

```
浏览器 ──HTTP/80──▶ web(Nginx) ──┬─ 静态页（前端）
                                 ├─ /api    ─▶ runtime:3002
                                 └─ /events ─▶ runtime:3002 ─▶ postgres:5432
```

---

## 一、准备 `.env`

后端的 LLM 配置等仍从「仓库根的 `.env`」读取（compose 用 `env_file: ../.env`）。
**`PG_URL` 不用管**——compose 会自动覆盖成容器内地址。其余按 `.env.example` 填好，至少要有：

```dotenv
API_KEY=sk-...            # LLM key（小米 MiMo 等 OpenAI 兼容服务）
BASE_URL=https://.../v1
MODEL_NAME=mimo-...
# BAIDU_SEARCH_API_KEY=...  # 可选，联网搜索
```

> `.env` 不会被打进镜像（已在 `.dockerignore` 里排除），只在运行时注入，安全。

## 二、一键启动

```bash
cd deploy
docker compose -f docker-compose.prod.yml up -d --build
```

- 首次构建较慢：要 `pnpm install` + 前端 `vite build`。
- 首次启动后端会联网下载模型（~360MB）到 `model_cache` 卷；之后重启不再重下。
- 启动后访问 **`http://<服务器IP>/`**。种子用户：`admin / admin`。

查看日志 / 状态：

```bash
docker compose -f docker-compose.prod.yml logs -f runtime
docker compose -f docker-compose.prod.yml ps
```

停止 / 重启 / 抹库重来：

```bash
docker compose -f docker-compose.prod.yml down          # 停（保留数据卷）
docker compose -f docker-compose.prod.yml down -v       # 连数据库/模型卷一起删，下次重新灌种子+下模型
docker compose -f docker-compose.prod.yml up -d --build  # 改了代码后重建
```

## 三、上 HTTPS（让 `https://你的域名` 能访问）

`web` 现在只开 80。三选一：

1. **最省事**：用云厂商的「负载均衡 / 应用网关」挂证书，回源到这台机的 80。
2. **机器上加一层 Caddy**：Caddy 自动签发并续期 Let's Encrypt 证书，反代到 `web:80`。
3. **直接改本仓库的 Nginx**：把 `web` 的端口改 `443:443`，在 `nginx.conf` 里加 `listen 443 ssl;` 和 `ssl_certificate` / `ssl_certificate_key`，并把证书目录挂进容器。

> 国内大陆服务器 + 域名访问需要 **ICP 备案**；不想备案可选香港/海外机。

## 四、常见问题

- **前端能打开但发消息无响应** → 多半是后端没连上 LLM。看 `logs -f runtime`，确认 `.env` 的 `API_KEY/BASE_URL/MODEL_NAME` 正确。
- **后端起不来、退出码 1** → `pingDb()` 失败，等 `postgres` healthy（compose 已配 `depends_on: condition: service_healthy`，正常会自动等）。
- **`onnxruntime-node` 加载报错** → 你的服务器 CPU 架构没有对应预编译包。把 `Dockerfile.runtime` 里安装 `build-essential python3` 的注释放开后重建。
- **改了后端代码不生效** → 镜像是构建期固化的源码，必须 `up -d --build` 重建（不像本地 `tsx` 热跑）。
- **内存不够 / reranker 加载被 kill** → cross-encoder 吃内存，建议 2 核 8G 起步；小机器可在 `.env` 把 `RERANK_DTYPE=q8`（已是默认）。

## 五、文件清单

```
deploy/
├── Dockerfile.runtime        后端镜像（glibc bookworm + pnpm + tsx）
├── Dockerfile.web            前端镜像（vite build → nginx 多阶段）
├── nginx.conf                静态托管 + /api、/events 反代（SSE 关缓冲）
├── docker-compose.prod.yml   三服务编排
└── README.md                 本文件
.dockerignore                 在仓库根（Docker 只认上下文根的这个文件）
```
