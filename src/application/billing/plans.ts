import type { BillingPlanId } from './types.js';

export interface BillingPlan {
  id: BillingPlanId;
  monthlyPriceUsd: number;
  // 2026-08-23 改回来：8/14 曾经改成"今天挂在语音频道里的连接时长"（墙钟时间，不管有
  // 没有人说话，靠 connection-usage-tracker.ts 每 5 分钟打点）。connection-usage-tracker.ts
  // 已删除——不再需要一个独立定时器持续戳 Postgres，限额语义改回"今天 STT 实际识别过的
  // 语音时长"，随每次 STT 调用返回后原子累加（session.ts 的 incrementSttSecondsUsed），
  // 不再需要单独的定时任务。
  dailySttSecondsLimit: number | null;
  dailyTextCharsLimit: number | null;
  allowedLanguageCodes: Set<string> | null;
}

export const BILLING_PLANS: Record<BillingPlanId, BillingPlan> = {
  free: {
    id: 'free',
    monthlyPriceUsd: 0,
    dailySttSecondsLimit: 20 * 60,
    dailyTextCharsLimit: 3000,
    allowedLanguageCodes: new Set(['zh', 'en', 'es', 'ja', 'ko']),
  },
  server: {
    id: 'server',
    monthlyPriceUsd: 19.99,
    dailySttSecondsLimit: null,
    dailyTextCharsLimit: null,
    allowedLanguageCodes: null,
  },
};

