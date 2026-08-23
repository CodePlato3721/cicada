import { dbPool } from '../../adapter/out/db/client.js';
import { createLogger } from '../../adapter/out/logger.js';
import { todayUtc } from '../../domain/date.js';
import { shouldSendBillingNotification, markBillingNotificationSent } from '../session.js';
import { BILLING_PLANS } from './plans.js';
import { calculateEstimatedCostUsd } from './cost-calculator.js';
import type { BillingDecision, ExternalApiUsage } from './types.js';

const logger = createLogger('billing');
const LOW_TEXT_CHARS_REMAINING_WARNING = 500;

function usageJson(usage: ExternalApiUsage): Record<string, unknown> {
  return Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined));
}

// export：connection-usage-tracker.ts 的定时打点也要拿 planId 判断限额，复用同一份
// "guild 第一次出现就顺手建账号"逻辑，不在那边另写一份容易跟这边走偏。
export async function ensureAccount(client: { query: typeof dbPool.query }, guildId: string): Promise<{ id: string; planId: 'free' | 'server'; status: string }> {
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
  textChars = 0,
  voiceLimitBlockedDate,
}: {
  guildId: string;
  sourceLang?: string;
  targetLang?: string;
  textChars?: number;
  // session.ts 的 session.voiceLimitBlockedDate——pipeline.ts 每句话本来就要 getSession()
  // 一次拿 source/targetLang，这个字段是同一次 Redis hgetall 顺带带出来的，不产生额外查询。
  // 跟 todayUtc() 相等就说明"今天的连接时长已经被 connection-usage-tracker.ts 的定时
  // 打点判定超额了"，不用再查一次 Postgres。
  voiceLimitBlockedDate?: string;
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

    if (plan.dailyConnectedSecondsLimit !== null && voiceLimitBlockedDate === todayUtc()) {
      // 没有 userMessage——connection-usage-tracker.ts 的定时打点在刚跨过限额线的那一刻
      // 已经往语音频道发过一次提醒了，这里每句话都会走到，不重复发。
      return {
        allowed: false,
        planId: account.planId,
        reason: 'daily voice channel connected-time limit reached',
      };
    }

    let warningMessage: string | undefined;

    if (plan.dailyTextCharsLimit !== null) {
      const usage = await client.query<{ text_chars: string }>(
        `
          select text_chars
          from daily_guild_usage
          where guild_id = $1 and usage_date = $2
        `,
        [guildId, todayUtc()],
      );
      const row = usage.rows[0] ?? { text_chars: '0' };
      const nextTextChars = Number(row.text_chars) + textChars;
      if (nextTextChars > plan.dailyTextCharsLimit) {
        const shouldNotify = await shouldSendBillingNotification(guildId, 'billingBlockedNotifiedAt');
        if (shouldNotify) await markBillingNotificationSent(guildId, 'billingBlockedNotifiedAt');
        return {
          allowed: false,
          planId: account.planId,
          reason: `daily text translation limit reached (${plan.dailyTextCharsLimit} chars)`,
          userMessage: shouldNotify
            ? `This server has reached the Free plan daily text translation limit (${plan.dailyTextCharsLimit} characters/day).`
            : undefined,
        };
      }
      const remainingChars = Math.max(plan.dailyTextCharsLimit - nextTextChars, 0);
      if (remainingChars <= LOW_TEXT_CHARS_REMAINING_WARNING && (await shouldSendBillingNotification(guildId, 'billingWarnedAt'))) {
        warningMessage = `This server has ${remainingChars} Free plan text character(s) left today.`;
        await markBillingNotificationSent(guildId, 'billingWarnedAt');
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

    // 连接时长（connected_seconds）不再从这里累加——那是 connection-usage-tracker.ts
    // 按 5 分钟一次的定时打点独立记的，跟这句话有没有说、STT 调没调用完全无关（见
    // CLAUDE.md「daily_usage_counters 重设计」）。这里只剩 llm 阶段的 text_chars 要记。
    if (usage.stage === 'llm') {
      await client.query(
        `
          insert into daily_guild_usage (guild_id, usage_date, text_chars)
          values ($1, $2, $3)
          on conflict (guild_id, usage_date) do update
          set text_chars = daily_guild_usage.text_chars + excluded.text_chars,
              updated_at = now()
        `,
        [usage.guildId, todayUtc(), usage.inputTextChars ?? 0],
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
