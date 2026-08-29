import pricingPlans from '../../config/pricing-plans.json' with { type: 'json' };
import type { BillingPlanId } from './types.js';

export interface BillingPlan {
  id: BillingPlanId;
  name: string;
  monthlyPriceUsd: number;
  dailySttSecondsLimit: number | null;
  dailyTextCharsLimit: number | null;
  allowedLanguageCodes: Set<string> | null;
}

export const BILLING_PLANS: Record<BillingPlanId, BillingPlan> = Object.fromEntries(
  pricingPlans.plans.map((plan) => [
    plan.id,
    {
      id: plan.id,
      name: plan.name,
      monthlyPriceUsd: plan.monthlyPriceUsd,
      dailySttSecondsLimit: plan.dailyMinutes === null ? null : plan.dailyMinutes * 60,
      dailyTextCharsLimit: plan.dailyTextChars,
      allowedLanguageCodes: plan.languages === null ? null : new Set(plan.languages),
    },
  ]),
) as Record<BillingPlanId, BillingPlan>;

export const DEFAULT_PLAN_ID: BillingPlanId = (pricingPlans.plans.find((plan) => plan.isDefault) ?? pricingPlans.plans[0]).id;

export const DEFAULT_PLAN: BillingPlan = BILLING_PLANS[DEFAULT_PLAN_ID];
