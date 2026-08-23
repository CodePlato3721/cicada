// UTC 日历日字符串（YYYY-MM-DD），跟 daily_guild_usage 的重置边界（usage_date）
// 用同一个函数/同一套语义，避免两处各写一份导致"重置时刻"不一致地漂移。
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
