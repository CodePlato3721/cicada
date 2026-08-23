import type { BillingPlanId } from './types.js';

export interface BillingPlan {
  id: BillingPlanId;
  monthlyPriceUsd: number;
  // 2026-08-23 改名：以前叫 dailyVoiceSecondsLimit，语义是"今天 STT 识别过的语音总时长"。
  // 现在改成"今天挂在语音频道里的连接时长"（/join 到 /leave 之间的墙钟时间，不管有没有
  // 人说话），按 5 分钟一次的定时打点累加，见 connection-usage-tracker.ts。
  dailyConnectedSecondsLimit: number | null;
  dailyTextCharsLimit: number | null;
  allowedLanguageCodes: Set<string> | null;
}

export const BILLING_PLANS: Record<BillingPlanId, BillingPlan> = {
  free: {
    id: 'free',
    monthlyPriceUsd: 0,
    dailyConnectedSecondsLimit: 20 * 60,
    dailyTextCharsLimit: 3000,
    allowedLanguageCodes: new Set(['zh', 'en', 'es', 'ja', 'ko']),
  },
  server: {
    id: 'server',
    monthlyPriceUsd: 19.99,
    dailyConnectedSecondsLimit: null,
    dailyTextCharsLimit: null,
    allowedLanguageCodes: null,
  },
};

