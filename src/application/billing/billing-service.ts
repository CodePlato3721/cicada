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
import { BILLING_PLANS } from './plans.js';
import { calculateSessionCostUsd } from './cost-calculator.js';
import type { BillingDecision, BillingPlanId, ExternalApiUsage } from './types.js';

const logger = createLogger('billing');
const LOW_TEXT_CHARS_REMAINING_WARNING = 500;

function planFor(session: Pick<Session, 'planId'>) {
  return BILLING_PLANS[session.planId as BillingPlanId] ?? BILLING_PLANS.free;
}

// 剩余时长/剩余字符 = 套餐上限（代码常量，plans.ts）- 今天已用量。只在这一处算，
// 调用方（syncDailyUsageToDb、billing-cli.js 的 plan 命令）负责把算好的结果写进
// billing_accounts 的物化列，不是每次读的时候都现算一遍。null 上限（server 套餐
// 不限量）算出来也是 null，不是 Infinity——数据库列存不了 Infinity。
export function remainingForPlan(
  planId: string,
  sttSecondsUsed: number,
  textCharsUsed: number,
): { sttSecondsRemaining: number | null; textCharsRemaining: number | null } {
  const plan = BILLING_PLANS[planId as BillingPlanId] ?? BILLING_PLANS.free;
  return {
    sttSecondsRemaining: plan.dailySttSecondsLimit === null ? null : Math.max(plan.dailySttSecondsLimit - sttSecondsUsed, 0),
    textCharsRemaining: plan.dailyTextCharsLimit === null ? null : Math.max(plan.dailyTextCharsLimit - textCharsUsed, 0),
  };
}

// export：/join（hydrateSessionBillingState）、/leave（finalizeSessionLedger）、billing-cli.js
// 都要拿"guild 第一次出现就顺手建账号"这同一份逻辑，不各自另写一份容易走偏。首次插入
// 顺手把剩余额度物化列初始化成 free 套餐（新账号默认套餐）的满额——之后已存在的账号
// on conflict 只碰 updated_at，不会拿这个默认值覆盖掉已经算好的真实剩余量。
export async function ensureAccount(
  client: { query: typeof dbPool.query },
  guildId: string,
): Promise<{ id: string; planId: 'free' | 'server'; status: string }> {
  const freePlan = BILLING_PLANS.free;
  const result = await client.query<{ id: string; plan_id: 'free' | 'server'; status: string }>(
    `
      insert into billing_accounts (guild_id, stt_seconds_remaining, text_chars_remaining)
      values ($1, $2, $3)
      on conflict (guild_id) do update set updated_at = now()
      returning id, plan_id, status
    `,
    [guildId, freePlan.dailySttSecondsLimit, freePlan.dailyTextCharsLimit],
  );
  const row = result.rows[0];
  return { id: row.id, planId: row.plan_id, status: row.status };
}

// /join 时调用一次——这场会话唯一一次为了"账单判断"目的读 Postgres。之后整场会话的
// checkSttAllowed/checkTranslateAllowed 都只读 Redis session hash 里缓存的这份状态，
// 不再每句话查库（见 CLAUDE.md billing 重设计一节）。
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

// 同一次同步顺手把 billing_accounts 的剩余额度物化列也更新掉（remainingForPlan 只在
// 这一处算，不在读的时候算）——两张表都落在这个低频同步点上（60 秒定时/跨限额线/
// session 结束/跨天重置），没有额外增加同步频率。
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

// 跨天检查：session 里的 sttSecondsUsedToday/textCharsUsedToday 是"usageDate 那一天"的
// 数字，一旦 usageDate 不再是 todayUtc()，先把旧一天的数字落盘（不然这段用量凭空丢失），
// 再把 Redis 计数器清零、usageDate 更新成今天——新的一天永远从 0 开始，不需要额外查库
// （daily_guild_usage 按 (guild_id, usage_date) 主键，新日期本来就还没有行）。重置之后
// 紧接着再同步一次（用量 0），让 billing_accounts 的剩余额度立刻回满，不用等下一次
// 60 秒定时才追上——不然跨天瞬间会有一小段时间残留着旧一天快耗尽的剩余额度。
async function ensureUsageDateCurrent(guildId: string, session: Session): Promise<void> {
  if (!session.usageDate || session.usageDate === todayUtc()) return;
  await syncDailyUsageToDb(guildId, session.usageDate, session.sttSecondsUsedToday, session.textCharsUsedToday, session.planId);
  await resetDailyUsageCounters(guildId);
  await syncDailyUsageToDb(guildId, todayUtc(), 0, 0, session.planId);
  logger.info({ guildId, oldDate: session.usageDate, newDate: todayUtc() }, `guild ${guildId} daily usage counters rolled over`);
}

// 由 voice-listener.js 每 60 秒定时调用一次（会话存续期间），以及用量刚跨过限额线时
// 立即调用一次（见 recordExternalApiUsage 底部），把 Redis 里的当前快照同步进
// daily_guild_usage——DB 始终是 source of truth，Redis 只是运行时的快、可丢的缓存层，
// 这个函数就是让两边不要越漂越远的手段。
export async function syncBillingStateToDb(guildId: string): Promise<void> {
  const session = await getSession(guildId);
  if (!session) return;
  await ensureUsageDateCurrent(guildId, session);
  const current = (await getSession(guildId)) ?? session;
  await syncDailyUsageToDb(guildId, current.usageDate ?? todayUtc(), current.sttSecondsUsedToday, current.textCharsUsedToday, current.planId);
}

// 由 voice-listener.js 在 onSpeechStart（VAD 刚确认"这是人声"）里调用，早于
// openStream()——用量超线时压根不开 STT 流，不产生这句话的 STT 成本，比"转写完了才
// 发现超线"更早拦截。纯同步、不做任何 I/O：sessionForStt 已经是调用方提前 await
// 好的最新数据，这里只是在内存里比大小。
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
      userMessage: `This server has reached the Free plan daily voice translation time limit (${Math.round(plan.dailySttSecondsLimit / 60)} minutes/day). Voice translation is paused until it resets at UTC midnight.`,
    };
  }

  return { allowed: true, planId: plan.id };
}

// checkSttAllowed 判定 blocked 时，voice-listener.js 调用这个把提示发进语音频道文字
// 聊天——独立拆出来是因为发消息要查一次 Redis 去重标记（今天发过就不重复刷屏），
// 这部分 I/O 不适合放进上面那个纯同步函数里。
export async function sendSttBlockedNotice(guildId: string, voiceChannel: VoiceBasedChannel, decision: BillingDecision): Promise<void> {
  if (!decision.userMessage) return;
  const field = decision.reason === 'daily STT time limit reached' ? 'sttBlockedNotifiedAt' : 'billingBlockedNotifiedAt';
  if (!(await shouldSendBillingNotification(guildId, field))) return;
  await markBillingNotificationSent(guildId, field);
  await voiceChannel.send(`⚠️ ${decision.userMessage}`).catch((err: unknown) => logger.error({ err, guildId }, 'Failed to send STT-blocked notice'));
}

// pipeline.js 的 handleSegment 在拿到转写文字、翻译之前调用——textChars 是这句话转写
// 结果的字符数，这个数字要送进 LLM 之前才知道，没法像 STT 时长那样提前拦（见
// checkSttAllowed 的注释）。account 状态/语言白名单同样只读 session 缓存，不查库。
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
  // session.sourceLang/targetLang 现在都是具体 locale（如 'zh-TW'/'en-US'，见
  // commands/language-choices.js），但 allowedLanguageCodes 这张白名单是按基础语言码
  // 维护的（'zh'/'en'/'es'/'ja'/'ko'，见 plans.ts）——直接拿 locale 去查会全部落空
  // （'zh-TW' 不在只含 'zh' 的 Set 里），导致 Free plan 的语言白名单形同虚设，查之前
  // 必须先 toBaseLang() 还原。
  const languages = [toBaseLang(session.sourceLang), toBaseLang(session.targetLang)].filter((lang): lang is string =>
    Boolean(lang),
  );
  if (plan.allowedLanguageCodes && languages.some((lang) => !plan.allowedLanguageCodes?.has(lang))) {
    return {
      allowed: false,
      planId: plan.id,
      reason: `plan ${plan.id} does not include ${languages.join('/')} translation`,
      userMessage: `This server is on the Free plan, which only supports ZH, EN, ES, JA, and KO. ${session.sourceLang ?? '?'} -> ${session.targetLang ?? '?'} requires the Server plan.`,
    };
  }

  if (plan.dailySttSecondsLimit !== null && session.sttSecondsUsedToday >= plan.dailySttSecondsLimit) {
    // 正常情况下 voice-listener.js 的 checkSttAllowed 应该已经在开 STT 流之前拦住了；
    // 走到这里说明这句话在处理过程中才刚好跨线（罕见竞态），兜底一下不让它继续翻译。
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

  return { allowed: true, planId: plan.id, warningMessage };
}

// 2026-08-23 重写：以前这个函数本身就是"开事务、写 usage_events、写 billing_ledger、
// 改 balance_usd"——每句话三次（STT/LLM/TTS）都各自触发一次 Postgres 事务，高频写入
// 不可接受（见 CLAUDE.md）。现在只做两件低成本的事：(1) 追加一行 JSONL 审计日志
// （adapter/out/events-log.js，纯本地磁盘 I/O），(2) 原子累加进 Redis（session.ts 的
// accumulateSessionUsage，供 /leave 时算这场会话的总成本；以及 sttSecondsUsedToday/
// textCharsUsedToday，供限额判断）。不再直接触碰 Postgres——真正落盘到
// daily_guild_usage/billing_session_ledger 是 syncBillingStateToDb/finalizeSessionLedger
// 的职责，那两个函数只在低频事件（60 秒定时、跨限额线、/leave）触发，不是每句话触发。
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
  if (!session) return; // /leave 跟这次调用撞了，会话已经没了，没地方可累加限额计数器
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
    // 刚跨过限额线——立即同步一次到 daily_guild_usage，不用等下一次 60 秒定时打点
    // （见 connection-usage-tracker.ts 曾经的同一个考虑）。不 await：这是一次
    // Postgres 写入，不该拖慢当前这句话本身的播放。
    void syncBillingStateToDb(guildId).catch((err) => logger.error({ err, guildId }, 'Failed to sync exhausted billing state to db'));
  }
}

// 由 voice-listener.js 的 stopListening（/leave）调用，必须在 deleteSession 清空 Redis
// 之前调用——这是唯一一个真正需要"这场会话的完整用量"的时刻，也是唯一往
// billing_session_ledger 写一行、往 billing_accounts.lifetime_cost_usd 累加的地方。
export async function finalizeSessionLedger(guildId: string): Promise<void> {
  const session = await getSession(guildId);
  if (!session?.sessionStartedAt) return; // 没有会话，或者是这次改动之前创建的老会话（缺这个字段），没法算，跳过

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
    logger.info(
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
