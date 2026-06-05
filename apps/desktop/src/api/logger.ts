// 前端日志器(基于 pino 的浏览器构建)。
// 每条日志都带:时间戳 + 级别 + 来源标签 [desktop],输出到浏览器/Tauri webview 的 console。
// 与 runtime 端(app=runtime)对称,方便对照同一次请求的两端日志。
import pino from "pino";

// 把时间格式化成 "2026-06-02 12:30:00"(本地时区,24 小时制,补零)。
function formatTime(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${y}-${mo}-${da} ${h}:${mi}:${s}`;
}

// pino 数字级别 → 级别名 + 对应的 console 方法。
function pickLevel(n: number): { label: string; fn: (...a: unknown[]) => void } {
  if (n >= 50) {
    return { label: "ERROR", fn: console.error.bind(console) };
  }
  if (n >= 40) {
    return { label: "WARN ", fn: console.warn.bind(console) };
  }
  if (n >= 30) {
    return { label: "INFO ", fn: console.log.bind(console) };
  }
  return { label: "DEBUG", fn: console.log.bind(console) };
}

// 记录「用户主动操作」的一条语义日志:用户点了哪个按钮 / 做了什么动作。
// 紧跟其后的请求日志(rpcClient 的「→ 发出请求」)就是这个动作触发的,两条对照即可还原「点击 → 请求」的因果。
// action=动作的人话描述(如「发送消息」);detail=可选的上下文字段(sessionId / 标题 / 文本长度等)。
export function logUserAction(action: string, detail?: Record<string, unknown>): void {
  if (detail) {
    logger.info({ action, ...detail }, `👤 用户操作: ${action}`);
  } else {
    logger.info({ action }, `👤 用户操作: ${action}`);
  }
}

export const logger = pino({
  level: "info",
  browser: {
    // asObject:把每条日志整理成一个对象交给 write,我们自己拼时间 + 标签 + 结构化字段。
    asObject: true,
    write: (raw: object) => {
      const o = raw as Record<string, unknown>;
      const level = typeof o.level === "number" ? o.level : 30;
      const picked = pickLevel(level);
      const msg = typeof o.msg === "string" ? o.msg : "";

      // 把 level/time/msg 以外的字段(url / method / 请求体 / 响应体等)单独拎出来打印。
      const fields: Record<string, unknown> = {};
      for (const key of Object.keys(o)) {
        if (key === "level" || key === "time" || key === "msg") {
          continue;
        }
        fields[key] = o[key];
      }

      const prefix = `[${formatTime(new Date())}] ${picked.label} [desktop] ${msg}`;
      if (Object.keys(fields).length > 0) {
        picked.fn(prefix, fields);
      } else {
        picked.fn(prefix);
      }
    },
  },
});
