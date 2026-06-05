import type { SessionMeta } from "../stores/sessions.js";

// 一个时间段分组:段标题 + 落在该段的会话(顺序沿用入参,即服务端给的 created_at DESC)。
export interface SessionGroup {
  label: string;
  sessions: SessionMeta[];
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// 5 个时间段,从新到旧。maxAge 是「距今不超过多少毫秒」算进这一段;最后一段兜底用 Infinity。
// 注意边界:age < maxAge 才算这一段,所以正好 1 小时会落到下一段「1 天之前」,与单测一致。
const BUCKETS: { label: string; maxAge: number }[] = [
  { label: "1 小时之前", maxAge: HOUR },
  { label: "1 天之前", maxAge: DAY },
  { label: "3 天之前", maxAge: 3 * DAY },
  { label: "30 天之前", maxAge: 30 * DAY },
  { label: "更早", maxAge: Infinity },
];

// 把一条会话的 created_at 解析成「距 now 的毫秒数」。缺失 / 不可解析时当作「现在」(age=0),
// 这样刚建好、还没回填 created_at 的会话不会沉到最底下,而是出现在最新段。
function ageOf(session: SessionMeta, now: number): number {
  const raw = session.created_at;
  if (!raw) {
    return 0;
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    return 0;
  }
  const age = now - parsed;
  if (age < 0) {
    return 0; // 时钟漂移导致的未来时间,按「现在」处理
  }
  return age;
}

// 选出某个 age 应该归入的段下标。从最新段往后找第一个 age < maxAge 的段。
function bucketIndexFor(age: number): number {
  for (let i = 0; i < BUCKETS.length; i++) {
    if (age < BUCKETS[i].maxAge) {
      return i;
    }
  }
  return BUCKETS.length - 1; // 理论到不了(最后一段 Infinity 必中),兜底回更早段
}

/**
 * 把会话列表按 created_at 的新旧分到 5 个时间段。
 * 段内保持入参顺序(服务端已按 created_at DESC 返回),空段不出现在结果里。
 */
export function groupSessionsByTime(list: SessionMeta[], now: number): SessionGroup[] {
  const buckets: SessionMeta[][] = [];
  for (let i = 0; i < BUCKETS.length; i++) {
    buckets.push([]);
  }

  for (const session of list) {
    const age = ageOf(session, now);
    const index = bucketIndexFor(age);
    buckets[index].push(session);
  }

  const groups: SessionGroup[] = [];
  for (let i = 0; i < BUCKETS.length; i++) {
    const sessions = buckets[i];
    if (sessions.length > 0) {
      groups.push({ label: BUCKETS[i].label, sessions });
    }
  }
  return groups;
}
