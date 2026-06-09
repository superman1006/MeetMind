import type { SessionMeta } from "../stores/sessions.js";

// 一个时间段分组:段标题 + 落在该段的会话(顺序沿用入参,即服务端给的 created_at DESC)。
export interface SessionGroup {
  label: string;
  sessions: SessionMeta[];
}

const DAY = 24 * 60 * 60 * 1000;

// 把 epoch 毫秒规整到它所在「本地自然日」的 0 点(本地午夜)。
// 「今天 / 昨天」按自然日切分,不是「距今 24 / 48 小时」的滚动窗——
// 否则昨晚 11 点建的会话今早会被误读成「今天」。
function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// 把一条会话的 created_at 解析成 epoch 毫秒。缺失 / 不可解析 / 未来时间都当作「现在」,
// 这样刚建好、还没回填 created_at 的会话会落进「今天」而不是沉到最底下。
function createdMsOf(session: SessionMeta, now: number): number {
  const raw = session.created_at;
  if (!raw) {
    return now;
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    return now;
  }
  if (parsed > now) {
    return now; // 时钟漂移导致的未来时间,按「现在」处理
  }
  return parsed;
}

// 5 个时间段,从新到旧。minCreated 是「创建时间不早于这个时刻」算进这一段:
//   今天    = 本地今天 0 点起
//   昨天    = 本地昨天 0 点起(到今天 0 点前)
//   7 天内  = 距今 7 天内(到昨天 0 点前)
//   30 天内 = 距今 30 天内(到 7 天前)
//   更早    = 其余(minCreated = -Infinity 兜底必中)
// 阈值从「今天 0 点 → 昨天 0 点 → 7 天前 → 30 天前」单调递减,所以从上往下第一个命中的段就是答案。
function buildBuckets(now: number): { label: string; minCreated: number }[] {
  const todayStart = startOfLocalDay(now);
  const yesterdayStart = todayStart - DAY;
  const weekAgo = now - 7 * DAY;
  const monthAgo = now - 30 * DAY;
  return [
    { label: "今天", minCreated: todayStart },
    { label: "昨天", minCreated: yesterdayStart },
    { label: "7 天内", minCreated: weekAgo },
    { label: "30 天内", minCreated: monthAgo },
    { label: "更早", minCreated: -Infinity },
  ];
}

// 选出某个 createdMs 应该归入的段下标。从最新段往后找第一个 createdMs >= minCreated 的段。
function bucketIndexFor(createdMs: number, buckets: { minCreated: number }[]): number {
  for (let i = 0; i < buckets.length; i++) {
    if (createdMs >= buckets[i].minCreated) {
      return i;
    }
  }
  return buckets.length - 1; // 理论到不了(最后一段 -Infinity 必中),兜底回更早段
}

/**
 * 把会话列表按 created_at 的新旧分到 5 个时间段(今天 / 昨天 / 7 天内 / 30 天内 / 更早)。
 * 段内保持入参顺序(服务端已按 created_at DESC 返回),空段不出现在结果里。
 */
export function groupSessionsByTime(list: SessionMeta[], now: number): SessionGroup[] {
  const buckets = buildBuckets(now);

  const collected: SessionMeta[][] = [];
  for (let i = 0; i < buckets.length; i++) {
    collected.push([]);
  }

  for (const session of list) {
    const createdMs = createdMsOf(session, now);
    const index = bucketIndexFor(createdMs, buckets);
    collected[index].push(session);
  }

  const groups: SessionGroup[] = [];
  for (let i = 0; i < buckets.length; i++) {
    const sessions = collected[i];
    if (sessions.length > 0) {
      groups.push({ label: buckets[i].label, sessions });
    }
  }
  return groups;
}
