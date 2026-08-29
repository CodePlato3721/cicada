import type { VoiceBasedChannel } from 'discord.js';
import { dbPool } from '../../adapter/out/db/client.js';
import { createLogger } from '../../adapter/out/logger.js';
import { appendUsageEvent, logEventsWriteFailure } from '../../adapter/out/events-log.js';
import { todayUtc } from '../../domain/date.js';
import { toBaseLang } from '../../domain/language.js';
import {
  getSession,
  shouldSendBillingNotification,
  markBillingNotificationSent,
  hydrateBillingState,
  incrementSttSecondsUsed,
  incrementTextCharsUsed,
  resetDailyUsageCounters,
  accumulateSessionUsage,
  readSessionUsageBreakdown,
  clearSessionUsageBreakdown,
  type Session,
} from '../session.js';
import { BILLING_PLANS, DEFAULT_PLAN } from './plans.js';
import { calculateSessionCostUsd } from './cost-calculator.js';
import type { BillingDecision, BillingPlanId, ExternalApiUsage } from './types.js';

const logger = createLogger('billing');
const LOW_TEXT_CHARS_REMAINING_WARNING = 500;

function planFor(session: Pick<Session, 'planId'>) {
  return BILLING_PLANS[session.planId as BillingPlanId] ?? DEFAULT_PLAN;
}

export function remainingForPlan(
  planId: string,
  sttSecondsUsed: number,
  textCharsUsed: number,
): { sttSecondsRemaining: number | null; textCharsRemaining: number | null } {
  const plan = BILLING_PLANS[planId as BillingPlanId] ?? DEFAULT_PLAN;
  return {
    sttSecondsRemaining: plan.dailySttSecondsLimit === null ? null : Math.max(plan.dailySttSecondsLimit - sttSecondsUsed, 0),
    textCharsRemaining: plan.dailyTextCharsLimit === null ? null : Math.max(plan.dailyTextCharsLimit - textCharsUsed, 0),
  };
}

export async function ensureAccount(
  client: { query: typeof dbPool.query },
  guildId: string,
): Promise<{ id: string; planId: BillingPlanId; status: string }> {
  const result = await client.query<{ id: string; plan_id: BillingPlanId; status: string }>(
    `
      insert into billing_accounts (guild_id, stt_seconds_remaining, text_chars_remaining)
      values ($1, $2, $3)
      on conflict (guild_id) do update set updated_at = now()
      returning id, plan_id, status
    `,
    [guildId, DEFAULT_PLAN.dailySttSecondsLimit, DEFAULT_PLAN.dailyTextCharsLimit],
  );
  const row = result.rows[0];
  return { id: row.id, planId: row.plan_id, status: row.status };
}

export async function hydrateSessionBillingState(guildId: string): Promise<void> {
  const account = await ensureAccount(dbPool, guildId);
  const usageResult = await dbPool.query<{ stt_seconds: string; text_chars: string }>(
    `select stt_seconds, text_chars from daily_guild_usage where guild_id = $1 and usage_date = $2`,
    [guildId, todayUtc()],
  );
  const row = usageResult.rows[0] ?? { stt_seconds: '0', text_chars: '0' };
  await hydrateBillingState(guildId, {
    planId: account.planId,
    accountStatus: account.status,
    sttSecondsUsedToday: Number(row.stt_seconds),
    textCharsUsedToday: Number(row.text_chars),
  });
  logger.info(
    { guildId, planId: account.planId, sttSecondsUsedToday: Number(row.stt_seconds), textCharsUsedToday: Number(row.text_chars) },
    `guild ${guildId} billing state hydrated from db`,
  );
}

async function syncDailyUsageToDb(guildId: string, usageDate: string, sttSeconds: number, textChars: number, planId: string): Promise<void> {
  await dbPool.query(
    `
      insert into daily_guild_usage (guild_id, usage_date, stt_seconds, text_chars)
      values ($1, $2, $3, $4)
      on conflict (guild_id, usage_date) do update
      set stt_seconds = excluded.stt_seconds,
          text_chars = excluded.text_chars,
          updated_at = now()
    `,
    [guildId, usageDate, sttSeconds, textChars],
  );

  const { sttSecondsRemaining, textCharsRemaining } = remainingForPlan(planId, sttSeconds, textChars);
  await dbPool.query(
    `update billing_accounts set stt_seconds_remaining = $2, text_chars_remaining = $3, updated_at = now() where guild_id = $1`,
    [guildId, sttSecondsRemaining, textCharsRemaining],
  );
}

async function ensureUsageDateCurrent(guildId: string, session: Session): Promise<void> {
  if (!session.usageDate || session.usageDate === todayUtc()) return;
  await syncDailyUsageToDb(guildId, session.usageDate, session.sttSecondsUsedToday, session.textCharsUsedToday, session.planId);
  await resetDailyUsageCounters(guildId);
  await syncDailyUsageToDb(guildId, todayUtc(), 0, 0, session.planId);
  logger.info({ guildId, oldDate: session.usageDate, newDate: todayUtc() }, `guild ${guildId} daily usage counters rolled over`);
}

export async function syncBillingStateToDb(guildId: string): Promise<void> {
  const session = await getSession(guildId);
  if (!session) return;
  await ensureUsageDateCurrent(guildId, session);
  const current = (await getSession(guildId)) ?? session;
  await syncDailyUsageToDb(guildId, current.usageDate ?? todayUtc(), current.sttSecondsUsedToday, current.textCharsUsedToday, current.planId);
}

export function checkSttAllowed(session: Pick<Session, 'planId' | 'accountStatus' | 'sttSecondsUsedToday'>): BillingDecision {
  if (session.accountStatus !== 'active') {
    return {
      allowed: false,
      planId: session.planId as BillingPlanId,
      reason: `billing account is ${session.accountStatus}`,
      userMessage: `Translation is unavailable because this server's billing account is ${session.accountStatus}.`,
    };
  }

  const plan = planFor(session);
  if (plan.dailySttSecondsLimit !== null && session.sttSecondsUsedToday >= plan.dailySttSecondsLimit) {
    return {
      allowed: false,
      planId: plan.id,
      reason: 'daily STT time limit reached',
      userMessage: `This server has reached the ${plan.name} plan daily voice translation time limit (${Math.round(plan.dailySttSecondsLimit / 60)} minutes/day). Voice translation is paused until it resets at UTC midnight.`,
    };
  }

  return { allowed: true, planId: plan.id };
}

export async function sendSttBlockedNotice(guildId: string, voiceChannel: VoiceBasedChannel, decision: BillingDecision): Promise<void> {
  if (!decision.userMessage) return;
  const field = decision.reason === 'daily STT time limit reached' ? 'sttBlockedNotifiedAt' : 'billingBlockedNotifiedAt';
  if (!(await shouldSendBillingNotification(guildId, field))) return;
  await markBillingNotificationSent(guildId, field);
  await voiceChannel.send(`⚠️ ${decision.userMessage}`).catch((err: unknown) => logger.error({ err, guildId }, 'Failed to send STT-blocked notice'));
}

export async function checkTranslateAllowed(guildId: string, session: Session, textChars: number): Promise<BillingDecision> {
  if (session.accountStatus !== 'active') {
    return {
      allowed: false,
      planId: session.planId as BillingPlanId,
      reason: `billing account is ${session.accountStatus}`,
      userMessage: `Translation is unavailable because this server's billing account is ${session.accountStatus}.`,
    };
  }

  const plan = planFor(session);
  const languages = [toBaseLang(session.sourceLang), toBaseLang(session.targetLang)].filter((lang): lang is string =>
    Boolean(lang),
  );
  if (plan.allowedLanguageCodes && languages.some((lang) => !plan.allowedLanguageCodes?.has(lang))) {
    const supportedList = [...plan.allowedLanguageCodes].map((lang) => lang.toUpperCase()).join(', ');
    return {
      allowed: false,
      planId: plan.id,
      reason: `plan ${plan.id} does not include ${languages.join('/')} translation`,
      userMessage: `This server is on the ${plan.name} plan, which only supports ${supportedList}. ${session.sourceLang ?? '?'} -> ${session.targetLang ?? '?'} requires a higher-tier plan.`,
    };
  }

  if (plan.dailySttSecondsLimit !== null && session.sttSecondsUsedToday >= plan.dailySttSecondsLimit) {
    return { allowed: false, planId: plan.id, reason: 'daily STT time limit reached' };
  }

  let warningMessage: string | undefined;

  if (plan.dailyTextCharsLimit !== null) {
    const nextTextChars = session.textCharsUsedToday + textChars;
    if (nextTextChars > plan.dailyTextCharsLimit) {
      const shouldNotify = await shouldSendBillingNotification(guildId, 'billingBlockedNotifiedAt');
      if (shouldNotify) await markBillingNotificationSent(guildId, 'billingBlockedNotifiedAt');
      return {
        allowed: false,
        planId: plan.id,
        reason: `daily text translation limit reached (${plan.dailyTextCharsLimit} chars)`,
        userMessage: shouldNotify
          ? `This server has reached the ${plan.name} plan daily text translation limit (${plan.dailyTextCharsLimit} characters/day).`
          : undefined,
      };
    }
    const remainingChars = Math.max(plan.dailyTextCharsLimit - nextTextChars, 0);
    if (remainingChars <= LOW_TEXT_CHARS_REMAINING_WARNING && (await shouldSendBillingNotification(guildId, 'billingWarnedAt'))) {
      warningMessage = `This server has ${remainingChars} ${plan.name} plan text character(s) left today.`;
      await markBillingNotificationSent(guildId, 'billingWarnedAt');
    }
  }

  return { allowed: true, planId: plan.id, warningMessage };
}

export async function recordExternalApiUsage(usage: ExternalApiUsage): Promise<void> {
  if (!usage.guildId) {
    logger.warn({ usage }, 'Skipping billing usage record without guildId');
    return;
  }
  const guildId = usage.guildId;

  await appendUsageEvent(guildId, { event: 'external_api_usage', ...usage }).catch((err) => logEventsWriteFailure(guildId, err));

  const provider = usage.provider ?? 'unknown';
  const model = usage.model ?? 'unknown';
  await accumulateSessionUsage(guildId, usage.stage, provider, model, {
    audioDurationSec: usage.providerAudioDurationSec ?? usage.audioDurationSec,
    promptTokens: usage.promptTokens,
    cachedPromptTokens: usage.cachedPromptTokens,
    completionTokens: usage.completionTokens,
    reasoningTokens: usage.reasoningTokens,
    inputTextChars: usage.inputTextChars,
  });

  const session = await getSession(guildId);
  if (!session) return;
  await ensureUsageDateCurrent(guildId, session);

  let justExhausted = false;
  const plan = planFor(session);

  if (usage.stage === 'stt') {
    const seconds = usage.providerAudioDurationSec ?? usage.audioDurationSec ?? 0;
    if (seconds > 0) {
      const totalAfter = await incrementSttSecondsUsed(guildId, seconds);
      justExhausted = plan.dailySttSecondsLimit !== null && totalAfter >= plan.dailySttSecondsLimit && totalAfter - seconds < plan.dailySttSecondsLimit;
    }
  } else if (usage.stage === 'llm') {
    const chars = usage.inputTextChars ?? 0;
    if (chars > 0) {
      const totalAfter = await incrementTextCharsUsed(guildId, chars);
      justExhausted = plan.dailyTextCharsLimit !== null && totalAfter >= plan.dailyTextCharsLimit && totalAfter - chars < plan.dailyTextCharsLimit;
    }
  }

  if (justExhausted) {
    void syncBillingStateToDb(guildId).catch((err) => logger.error({ err, guildId }, 'Failed to sync exhausted billing state to db'));
  }
}

export async function finalizeSessionLedger(guildId: string): Promise<void> {
  const session = await getSession(guildId);
  if (!session?.sessionStartedAt) return;

  await ensureUsageDateCurrent(guildId, session);
  const current = (await getSession(guildId)) ?? session;
  await syncDailyUsageToDb(guildId, current.usageDate ?? todayUtc(), current.sttSecondsUsedToday, current.textCharsUsedToday, current.planId);

  const usageBreakdown = await readSessionUsageBreakdown(guildId);
  const startedAt = new Date(session.sessionStartedAt);
  const endedAt = new Date();
  const durationSeconds = Math.max((endedAt.getTime() - startedAt.getTime()) / 1000, 0);

  const client = await dbPool.connect();
  try {
    const account = await ensureAccount(client, guildId);
    const { totalCostUsd, breakdown } = await calculateSessionCostUsd(client, usageBreakdown);

    await client.query('begin');
    await client.query(
      `
        insert into billing_session_ledger (guild_id, session_started_at, session_ended_at, duration_seconds, estimated_cost_usd, usage_breakdown)
        values ($1, $2, $3, $4, $5, $6)
      `,
      [guildId, startedAt.toISOString(), endedAt.toISOString(), durationSeconds, totalCostUsd, JSON.stringify(breakdown)],
    );
    await client.query(
      `update billing_accounts set lifetime_cost_usd = lifetime_cost_usd + $2, updated_at = now() where id = $1`,
      [account.id, totalCostUsd],
    );
    await client.query('commit');
    logger.debug(
      { guildId, durationSeconds, totalCostUsd },
      `guild ${guildId} session ledger recorded: ${durationSeconds.toFixed(0)}s connected, $${totalCostUsd} estimated cost`,
    );
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    logger.error({ err, guildId }, 'Failed to finalize session ledger');
  } finally {
    client.release();
  }

  await clearSessionUsageBreakdown(guildId);
}
