export type BillingPlanId = 'free' | 'server';
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
