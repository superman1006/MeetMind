# 用户记忆查看 / 编辑 设计

日期：2026-06-05

## 目标

会话界面左下角的用户头像（展开态 `.user-chip` / 收缩态 `.rail-avatar`），当前点击直接登出。改为：点击头像弹出一个小的圆角长方形弹层（popover），内含两个圆角长方形按钮——「用户记忆」和「退出登陆」。点「用户记忆」打开一个记忆窗口：顶部标题「用户记忆」，下面一个大圆角文本框（textarea），右下角「保存」。打开时从后端读当前用户的 memory，保存时写回。

## 关键决策

- **用户标识用 `username`**：整个应用都以 `username` 作为用户标识（`auth` store 只存 username，`session.create` / `session.list` 都按 username 隔离）。`user` 表虽有数字 `id`，但登录流程不返回 / 不保存它，故 `user.getMemory` / `user.setMemory` 一律传 `username`，与现有 RPC 一致。
- **memory 列已存在**：`<prefix>_user` 表（`ensureUserTable`）已有 `memory TEXT` 列，无需 DDL 迁移。
- **登出去向**：头像点击不再直接登出，改为弹出 popover，登出收进 popover 里的「退出登陆」按钮。
- **窗口布局**：标题 +「可编辑」textarea（载入当前 memory 直接编辑），不是「只读展示 + 另一个输入框」。

## 后端（`apps/runtime`）

### `database/users/userStore.ts`

新增两个函数，沿用现有风格（`usersTable()` 取表名、正文走 `$n` 占位符、明文 demo）：

- `getMemory(username: string): Promise<string>`
  - `SELECT memory FROM <prefix>_user WHERE username = $1`
  - 命中：返回 `rows[0].memory ?? ""`（列为 NULL 当空串）；未命中：返回 `""`。
- `setMemory(username: string, memory: string): Promise<void>`
  - `UPDATE <prefix>_user SET memory = $2 WHERE username = $1`

### `server/rpcServer.ts`

新增两个 method（鉴权口径与 `session.*` 一致，缺参回 `-32602`）：

- `user.getMemory`
  - 校验 `params.username` 是非空字符串，否则 `rpcError(id, -32602, "缺少 username")`。
  - `const memory = await userStore.getMemory(username)` → `rpcOk(id, { memory })`。
- `user.setMemory`
  - 校验 `params.username` 是非空字符串，否则 `-32602`。
  - 校验 `params.memory` 是 `string`（**空字符串允许**，表示清空记忆），否则 `rpcError(id, -32602, "memory 必须是字符串")`。
  - `await userStore.setMemory(username, memory)` → `rpcOk(id, { ok: true })`。

> 注意：改了 `rpcServer.ts` 新增 method 后必须重启 runtime 进程（`tsx` 不 watch），否则前端调新 method 会收到「未知方法」。

### 测试

- `userStore.test.ts`：mock `getPgPool().query`，断言 `getMemory` / `setMemory` 拼的 SQL（含表名 `meetmind_user`、`$n` 占位符、参数顺序）与返回映射（NULL / 未命中 → `""`）。
- `rpcServer.test.ts`：按现有 mock userStore 的方式，断言 `user.getMemory` 回 `{ memory }`、`user.setMemory` 回 `{ ok: true }`，以及缺 `username` / `memory` 非字符串时回 `-32602`。

## 前端（`apps/desktop`）

### `stores/auth.ts`

新增两个 action（都用 `this.username`，配 `logUserAction`）：

- `async getMemory(): Promise<string>` → `rpc<{ memory: string }>("user.getMemory", { username: this.username })`，返回 `result.memory`。
- `async setMemory(memory: string): Promise<void>` → `rpc("user.setMemory", { username: this.username, memory })`。

### 新增 `components/UserMemory.vue`

参照 `ModelSettings.vue` 的模态约定：

- 结构：`.overlay`（点空白处关闭）+ `.dialog`（`@click.stop`）。
- `onMounted`：注册 Esc 关闭监听；调 `auth.getMemory()` 回填 textarea，载入期间显示「读取中…」。
- `onBeforeUnmount`：移除监听。
- 顶部 `<h2>` 标题「用户记忆」。
- 一个大圆角 `<textarea>`（占主体高度，`resize: vertical`），`v-model` 绑当前记忆文本。
- 底部 actions：右下角「取消」+「保存」。保存进行中禁用按钮、不可 Esc 关闭。
- `onSave`：`await auth.setMemory(text)` → `ui.showToast("记忆已保存")` → `emit("close")`；失败 `console.error` + toast 提示。
- `defineEmits<{ close: [] }>()`。

### `components/SessionList.vue`

- 新增 `const menuOpen = ref(false)` 和 `const memoryOpen = ref(false)`。
- 头像点击行为从 `auth.logout()` 改为 `menuOpen = !menuOpen`（展开态 `.user-chip` 与收缩态 `.rail-avatar` 都改）。
- Tooltip label 从「登出 {username}」改为「账户 {username}」。
- 新增 popover：一个圆角长方形容器 `.user-menu`（`position: absolute`，定位在头像上方），内含两个圆角长方形按钮：
  - 「用户记忆」→ `memoryOpen = true; menuOpen = false`。
  - 「退出登陆」→ `auth.logout()`（无需手动关 popover，登出后整个会话界面会被 `App.vue` 切走）。
- popover 外点击 / Esc 关闭：用一个透明全屏 `.menu-backdrop`（`position: fixed; inset: 0`，z-index 低于 popover）捕获外部点击 `@click="menuOpen = false"`；Esc 复用一个 keydown 监听。
- 模板末尾挂 `<UserMemory v-if="memoryOpen" @close="memoryOpen = false" />`。

## 数据流

```
头像 click → popover { 用户记忆 | 退出登陆 }
  用户记忆 → UserMemory 模态
     onMount → rpc user.getMemory {username} → textarea 回填
     onSave  → rpc user.setMemory {username, memory} → toast → close
  退出登陆 → auth.logout()
```

## 错误处理

- 后端缺参 / 类型错 → `-32602`，前端 `rpc()` 抛错由调用方 `try/catch` + `console.error` 兜住。
- `getMemory` 未命中用户 / NULL 列 → 返回 `""`，前端 textarea 显示空。
- `setMemory` 允许空串（清空记忆）。

## 不做（YAGNI）

- 不做 memory 的版本历史 / 多条记忆，单字段全量覆盖。
- 不改登录流程返回 id，不引入数字 id 标识。
- memory 不进 LLM / 不参与讨论（本设计仅做查看与编辑入口）。
