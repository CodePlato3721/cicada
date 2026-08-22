import { dbPool } from '../../adapter/out/db/client.js';
import { createLogger } from '../../adapter/out/logger.js';
import { BILLING_PLANS } from './plans.js';
import { calculateEstimatedCostUsd } from './cost-calculator.js';
import type { BillingDecision, ExternalApiUsage } from './types.js';

const logger = createLogger('billing');
const LOW_VOICE_SECONDS_REMAINING_WARNING = 5 * 60;
const LOW_TEXT_CHARS_REMAINING_WARNING = 500;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function usageJson(usage: ExternalApiUsage): Record<string, unknown> {
  return Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined));
}

async function ensureAccount(client: { query: typeof dbPool.query }, guildId: string): Promise<{ id: string; planId: 'free' | 'server'; status: string }> {
  const result = await client.query<{ id: string; plan_id: 'free' | 'server'; status: string }>(
    `
      insert into billing_accounts (guild_id)
      values ($1)
      on conflict (guild_id) do update set updated_at = now()
      returning id, plan_id, status
    `,
    [guildId],
  );
  const row = result.rows[0];
  return { id: row.id, planId: row.plan_id, status: row.status };
}

export async function checkBillingAllowed({
  guildId,
  sourceLang,
  targetLang,
  voiceSeconds = 0,
  textChars = 0,
}: {
  guildId: string;
  sourceLang?: string;
  targetLang?: string;
  voiceSeconds?: number;
  textChars?: number;
}): Promise<BillingDecision> {
  const client = await dbPool.connect();
  try {
    const account = await ensureAccount(client, guildId);
    if (account.status !== 'active') {
      return {
        allowed: false,
        planId: account.planId,
        reason: `billing account is ${account.status}`,
        userMessage: `Translation is unavailable because this server's billing account is ${account.status}.`,
      };
    }

    const plan = BILLING_PLANS[account.planId];
    const languages = [sourceLang, targetLang].filter((lang): lang is string => Boolean(lang));
    if (plan.allowedLanguageCodes && languages.some((lang) => !plan.allowedLanguageCodes?.has(lang))) {
      return {
        allowed: false,
        planId: account.planId,
        reason: `plan ${plan.id} does not include ${languages.join('/')} translation`,
        userMessage: `This server is on the Free plan, which only supports ZH, EN, ES, JA, and KO. ${sourceLang ?? '?'} -> ${targetLang ?? '?'} requires the Server plan.`,
      };
    }

    let warningMessage: string | undefined;

    if (plan.dailyVoiceSecondsLimit !== null || plan.dailyTextCharsLimit !== null) {
      const usage = await client.query<{ voice_seconds: string; text_chars: string }>(
        `
          select voice_seconds, text_chars
          from daily_usage_counters
          where guild_id = $1 and usage_date = $2
        `,
        [guildId, todayUtc()],
      );
      const row = usage.rows[0] ?? { voice_seconds: '0', text_chars: '0' };
      const nextVoiceSeconds = Number(row.voice_seconds) + voiceSeconds;
      const nextTextChars = Number(row.text_chars) + textChars;
      if (plan.dailyVoiceSecondsLimit !== null && nextVoiceSeconds > plan.dailyVoiceSecondsLimit) {
        return {
          allowed: false,
          planId: account.planId,
          reason: `daily voice translation limit reached (${plan.dailyVoiceSecondsLimit}s)`,
          userMessage: `This server has reached the Free plan daily voice translation limit (${Math.round(plan.dailyVoiceSecondsLimit / 60)} minutes/day).`,
        };
      }
      if (plan.dailyTextCharsLimit !== null && nextTextChars > plan.dailyTextCharsLimit) {
        return {
          allowed: false,
          planId: account.planId,
          reason: `daily text translation limit reached (${plan.dailyTextCharsLimit} chars)`,
          userMessage: `This server has reached the Free plan daily text translation limit (${plan.dailyTextCharsLimit} characters/day).`,
        };
      }
      if (plan.dailyVoiceSecondsLimit !== null) {
        const remainingSeconds = Math.max(plan.dailyVoiceSecondsLimit - nextVoiceSeconds, 0);
        if (remainingSeconds <= LOW_VOICE_SECONDS_REMAINING_WARNING) {
          warningMessage = `This server has about ${Math.ceil(remainingSeconds / 60)} minute(s) of Free plan voice translation left today.`;
        }
      }
      if (plan.dailyTextCharsLimit !== null) {
        const remainingChars = Math.max(plan.dailyTextCharsLimit - nextTextChars, 0);
        if (remainingChars <= LOW_TEXT_CHARS_REMAINING_WARNING) {
          const textWarning = `This server has ${remainingChars} Free plan text character(s) left today.`;
          warningMessage = warningMessage ? `${warningMessage} ${textWarning}` : textWarning;
        }
      }
    }

    return { allowed: true, planId: account.planId, warningMessage };
  } finally {
    client.release();
  }
}

export async function recordExternalApiUsage(usage: ExternalApiUsage): Promise<void> {
  if (!usage.guildId) {
    logger.warn({ usage }, 'Skipping billing usage record without guildId');
    return;
  }

  const client = await dbPool.connect();
  try {
    await client.query('begin');
    const account = await ensureAccount(client, usage.guildId);
    const estimatedCostUsd = await calculateEstimatedCostUsd(client, usage);
    const payload = usageJson(usage);
    const eventResult = await client.query<{ id: string }>(
      `
        insert into usage_events (
          guild_id, user_id, sequence, stage, provider, model, source_lang, target_lang,
          quantity_audio_seconds, quantity_text_chars, prompt_tokens, cached_prompt_tokens,
          completion_tokens, reasoning_tokens, keyterm_count, estimated_cost_usd, usage_json
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        returning id
      `,
      [
        usage.guildId,
        usage.userId ?? null,
        usage.sequence ?? null,
        usage.stage,
        usage.provider ?? null,
        usage.model ?? null,
        usage.sourceLang ?? null,
        usage.targetLang ?? null,
        usage.providerAudioDurationSec ?? usage.audioDurationSec ?? null,
        usage.inputTextChars ?? null,
        usage.promptTokens ?? null,
        usage.cachedPromptTokens ?? null,
        usage.completionTokens ?? null,
        usage.reasoningTokens ?? null,
        usage.keytermCount ?? null,
        estimatedCostUsd,
        payload,
      ],
    );

    if (estimatedCostUsd > 0) {
      await client.query(
        `
          insert into billing_ledger (account_id, type, amount_usd, usage_event_id, description)
          values ($1, 'provider_cost', $2, $3, $4)
        `,
        [account.id, -estimatedCostUsd, eventResult.rows[0].id, `${usage.stage} ${usage.provider ?? 'unknown'}/${usage.model ?? 'unknown'}`],
      );
      await client.query(
        `
          update billing_accounts
          set balance_usd = balance_usd - $2,
              updated_at = now()
          where id = $1
        `,
        [account.id, estimatedCostUsd],
      );
    }

    if (usage.stage === 'stt' || usage.stage === 'llm') {
      await client.query(
        `
          insert into daily_usage_counters (guild_id, usage_date, voice_seconds, text_chars)
          values ($1, $2, $3, $4)
          on conflict (guild_id, usage_date) do update
          set voice_seconds = daily_usage_counters.voice_seconds + excluded.voice_seconds,
              text_chars = daily_usage_counters.text_chars + excluded.text_chars,
              updated_at = now()
        `,
        [
          usage.guildId,
          todayUtc(),
          usage.stage === 'stt' ? usage.providerAudioDurationSec ?? usage.audioDurationSec ?? 0 : 0,
          usage.stage === 'llm' ? usage.inputTextChars ?? 0 : 0,
        ],
      );
    }

    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    logger.error({ err, usage }, 'Failed to record billing usage');
    throw err;
  } finally {
    client.release();
  }
}
