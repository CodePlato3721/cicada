import pricingPlans from '../../config/pricing-plans.json' with { type: 'json' };

// 套餐 id 的集合从 pricing-plans.json 派生，不在这里手写字面量联合类型——新增/下架一个
// 套餐只改那一份 JSON，这里的类型跟着自动变，不用两处同步（也不会出现"JSON 里加了个
// 套餐、这里的联合类型忘了跟着加"这种漏改）。实际的套餐详情（价格/限额/语言白名单）见
// plans.ts，这里只取 id 这一列。
export type BillingPlanId = (typeof pricingPlans.plans)[number]['id'];
export type BillingAccountStatus = 'active' | 'suspended';
export type UsageStage = 'stt' | 'llm' | 'tts';

export interface ExternalApiUsage {
  stage: UsageStage;
  guildId?: string;
  userId?: string;
  sequence?: number;
  who?: string;
  sourceLang?: string;
  targetLang?: string;
  provider?: string;
  model?: string;
  voice?: string;
  elapsedMs?: number;
  inputTextChars?: number;
  outputTextChars?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedPromptTokens?: number;
  reasoningTokens?: number;
  audioDurationSec?: number;
  providerAudioDurationSec?: number;
  audioBytes?: number;
  chunkCount?: number;
  keytermCount?: number;
  usage?: unknown;
}

export interface BillingDecision {
  allowed: boolean;
  reason?: string;
  userMessage?: string;
  warningMessage?: string;
  planId?: BillingPlanId;
}
