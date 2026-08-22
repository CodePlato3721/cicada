import type { BillingPlanId } from './types.js';

export interface BillingPlan {
  id: BillingPlanId;
  monthlyPriceUsd: number;
  dailyVoiceSecondsLimit: number | null;
  dailyTextCharsLimit: number | null;
  allowedLanguageCodes: Set<string> | null;
}

export const BILLING_PLANS: Record<BillingPlanId, BillingPlan> = {
  free: {
    id: 'free',
    monthlyPriceUsd: 0,
    dailyVoiceSecondsLimit: 20 * 60,
    dailyTextCharsLimit: 3000,
    allowedLanguageCodes: new Set(['zh', 'en', 'es', 'ja', 'ko']),
  },
  server: {
    id: 'server',
    monthlyPriceUsd: 19.99,
    dailyVoiceSecondsLimit: null,
    dailyTextCharsLimit: null,
    allowedLanguageCodes: null,
  },
};

