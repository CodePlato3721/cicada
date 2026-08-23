import type { VoiceBasedChannel } from 'discord.js';
import { dbPool } from '../../adapter/out/db/client.js';
import { createLogger } from '../../adapter/out/logger.js';
import { todayUtc } from '../../domain/date.js';
import { isVoiceLimitBlocked, markVoiceLimitBlocked } from '../session.js';
import { ensureAccount } from './billing-service.js';
import { BILLING_PLANS } from './plans.js';

const logger = createLogger('billing/connection-usage');

// 2026-08-23：daily_guild_usage.connected_seconds 不再靠每句话说完后累加 STT 时长，
// 改成"只要 bot 还挂在语音频道里，不管有没有人说话"按固定间隔打点——这是用户明确
// 要的语义（从 /join 计时到 /leave，不是从第一句话说完开始算）。5 分钟一次、
// 允许 ±5 分钟误差都是用户接受的取舍，见 CLAUDE.md。
const TICK_MS = 5 * 60 * 1000;
const TICK_SECONDS = TICK_MS / 1000;

// guildId -> 定时器句柄。纯内存态，进程重启就丢——语音连接本身（@discordjs/voice 的
// VoiceConnection）也是纯内存态、重启后一样得重新 /join，这个计时器的生命周期
// 完全依附于那个连接，不需要比它更"抗重启"。
const timers = new Map<string, NodeJS.Timeout>();

async function tick(guildId: string, voiceChannel: VoiceBasedChannel): Promise<void> {
  try {
    const account = await ensureAccount(dbPool, guildId);
    const plan = BILLING_PLANS[account.planId];

    const result = await dbPool.query<{ connected_seconds: string }>(
      `
        insert into daily_guild_usage (guild_id, usage_date, connected_seconds)
        values ($1, $2, $3)
        on conflict (guild_id, usage_date) do update
        set connected_seconds = daily_guild_usage.connected_seconds + excluded.connected_seconds,
            updated_at = now()
        returning connected_seconds
      `,
      [guildId, todayUtc(), TICK_SECONDS],
    );

    const totalSeconds = Number(result.rows[0].connected_seconds);
    logger.info({ guildId, totalSeconds, limit: plan.dailyConnectedSecondsLimit }, `guild ${guildId} connected-time tick: ${totalSeconds}s today`);

    if (plan.dailyConnectedSecondsLimit === null || totalSeconds < plan.dailyConnectedSecondsLimit) return;

    // 已经超线——只在"刚跨过线"那一次发提醒，之后每 5 分钟还是超线也不会重复刷屏
    // （跟 billing-service.js 的 billingWarnedAt/billingBlockedNotifiedAt 同一个思路）。
    const alreadyBlocked = await isVoiceLimitBlocked(guildId);
    await markVoiceLimitBlocked(guildId);
    if (alreadyBlocked) return;

    logger.info({ guildId, totalSeconds }, `guild ${guildId} reached daily voice channel connected-time limit`);
    await voiceChannel
      .send(
        `This server has reached the Free plan daily voice channel time limit (${Math.round(
          (plan.dailyConnectedSecondsLimit ?? 0) / 60,
        )} minutes/day). Voice translation is paused until it resets at UTC midnight.`,
      )
      .catch((err) => logger.error({ err, guildId }, 'Failed to send voice channel time limit notice'));
  } catch (err) {
    logger.error({ err, guildId }, 'Failed to record periodic connected-time tick');
  }
}

// 由 voice-listener.js 的 startListening（/join 的实际实现）调用。
export function startTrackingConnection(guildId: string, voiceChannel: VoiceBasedChannel): void {
  stopTrackingConnection(guildId);
  // 立即打一次点，而不是等满 5 分钟——覆盖"当天已经在别的 session 里用超了额度，
  // 这次重新 /join"的情况，不用再等最多 5 分钟才发现，只是把发现延迟从"最多 5 分钟"
  // 缩短到"几乎立即"，不影响上面已经接受的 ±5 分钟总体误差。
  void tick(guildId, voiceChannel);
  const timer = setInterval(() => void tick(guildId, voiceChannel), TICK_MS);
  timer.unref?.();
  timers.set(guildId, timer);
}

// 由 voice-listener.js 的 stopListening（/leave 的实际实现）调用。最后不足 5 分钟的
// 零头不补记——跟上面同一个 ±5 分钟误差取舍，不为了这点精度多维护"上次打点是什么
// 时候"这份状态。
export function stopTrackingConnection(guildId: string): void {
  const timer = timers.get(guildId);
  if (timer) {
    clearInterval(timer);
    timers.delete(guildId);
  }
}
