import type { Gender } from '../domain/pitch.js';
import { redisClient } from '../adapter/out/redis/client.js';
import { createLogger } from '../adapter/out/logger.js';
import { todayUtc } from '../domain/date.js';
import { toBaseLang } from '../domain/language.js';
import { resolveTtsProvider } from './ports/tts.js';

const logger = createLogger('session');

export interface SpeakerState {
  label?: string;
  gender?: Gender;
  lastTranscript?: string;
  voice?: string;
}

export interface Session {
  speakers: Map<string, SpeakerState>;
  speakerSeq: number;
  playbackSeq: number;
  sourceLang: string | undefined;
  targetLang: string | undefined;
  ttsProvider: string | undefined;
  game: string | undefined;
  // 2026-08-23 billing 重设计：以下字段替代了旧的 voiceLimitBlockedDate + 每句话查
  // Postgres 的 checkBillingAllowed。planId/accountStatus 在 /join 时从 Postgres
  // 读一次缓存进来（hydrateBillingState，见 billing-service.js），之后整场会话直接读
  // 这份缓存，不再每句话查库；账号状态/套餐中途在别处被改了，最多要等下次 /join 才会
  // 生效，这是刻意的取舍（换来零高频 DB 查询）。
  planId: string;
  accountStatus: string;
  // 今天(UTC)已经用掉的 STT 秒数/翻译输入字符数，从 0（或 /join 时从
  // daily_guild_usage 读到的今天已用量，见 hydrateBillingState）开始单调递增，
  // 只增不减——限额判断是"用量 >= 套餐上限"，不是维护一个会减少的"剩余额度"，
  // 这样 usageDate 跨天重置时只需要清零，不需要重新算"剩余"是多少。
  sttSecondsUsedToday: number;
  textCharsUsedToday: number;
  // 上面两个计数器对应的是哪个 UTC 日期——每次读写前跟 todayUtc() 比较，不一致就说明
  // 跨天了，先把旧一天的数字同步进 daily_guild_usage（那才是它们真正归属的日期），
  // 再清零、把这个字段更新成今天（见 billing-service.js 的 ensureUsageDateCurrent）。
  usageDate: string | undefined;
  // 这场会话（/join 到 /leave）开始的时间，billing_session_ledger 那一行记录的
  // session_started_at 用这个，不是"今天第一次用量发生的时间"。
  sessionStartedAt: string | undefined;
}

type SessionHash = Record<string, string>;

function sessionKey(guildId: string): string {
  return `session:guild:${guildId}`;
}

// 单独一个 hash，不跟主 session hash 混在一起：这里存的是"这场会话至今按
// stage|provider|model 分组的原始用量"（STT 秒数/LLM token 数/TTS 字符数），只在
// /leave 时读一次、算出这场会话的 estimated_cost_usd 写进 billing_session_ledger，
// 跟主 session hash 那些"每句话都要读"的字段生命周期和读取频率完全不同，分开存
// 互不干扰、也方便单独 del。
function usageBreakdownKey(guildId: string): string {
  return `session:guild:${guildId}:usage`;
}

function speakerIdsKey(guildId: string): string {
  return `session:guild:${guildId}:speakers`;
}

function speakerKey(guildId: string, userId: string): string {
  return `session:guild:${guildId}:speaker:${userId}`;
}

function fromSessionHash(data: SessionHash, speakers: Map<string, SpeakerState>): Session {
  return {
    speakers,
    speakerSeq: Number(data.speakerSeq ?? 0),
    playbackSeq: Number(data.playbackSeq ?? 0),
    sourceLang: data.sourceLang,
    targetLang: data.targetLang,
    ttsProvider: data.ttsProvider,
    game: data.game,
    planId: data.planId ?? 'free',
    accountStatus: data.accountStatus ?? 'active',
    sttSecondsUsedToday: Number(data.sttSecondsUsedToday ?? 0),
    textCharsUsedToday: Number(data.textCharsUsedToday ?? 0),
    usageDate: data.usageDate,
    sessionStartedAt: data.sessionStartedAt,
  };
}

function fromSpeakerHash(data: SessionHash): SpeakerState {
  const speaker: SpeakerState = {};
  if (data.label) speaker.label = data.label;
  if (data.gender) speaker.gender = data.gender as Gender;
  if (data.lastTranscript) speaker.lastTranscript = data.lastTranscript;
  if (data.voice) speaker.voice = data.voice;
  return speaker;
}

function speakerHash(speaker: SpeakerState): Record<string, string> {
  return Object.fromEntries(
    Object.entries({
      label: speaker.label,
      gender: speaker.gender,
      lastTranscript: speaker.lastTranscript,
      voice: speaker.voice,
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

async function sessionExists(guildId: string): Promise<boolean> {
  return (await redisClient.exists(sessionKey(guildId))) === 1;
}

async function readSpeakers(guildId: string): Promise<Map<string, SpeakerState>> {
  const userIds = await redisClient.smembers(speakerIdsKey(guildId));
  const speakers = new Map<string, SpeakerState>();

  await Promise.all(
    userIds.map(async (userId) => {
      const data = await redisClient.hgetall(speakerKey(guildId, userId));
      if (Object.keys(data).length > 0) {
        speakers.set(userId, fromSpeakerHash(data));
      }
    }),
  );

  return speakers;
}

async function clearSpeakerVoices(guildId: string): Promise<void> {
  const userIds = await redisClient.smembers(speakerIdsKey(guildId));
  if (userIds.length === 0) return;
  await Promise.all(userIds.map((userId) => redisClient.hdel(speakerKey(guildId, userId), 'voice')));
}

export async function createSession(guildId: string): Promise<Session> {
  await deleteSession(guildId);
  const initial: SessionHash = {
    speakerSeq: '0',
    playbackSeq: '0',
    sessionStartedAt: new Date().toISOString(),
  };
  await redisClient.hset(sessionKey(guildId), initial);
  logger.info({ guildId }, `guild ${guildId} voice session created`);
  return fromSessionHash(initial, new Map());
}

export async function getSession(guildId: string): Promise<Session | undefined> {
  const data = await redisClient.hgetall(sessionKey(guildId));
  if (Object.keys(data).length === 0) return undefined;
  return fromSessionHash(data, await readSpeakers(guildId));
}

export async function deleteSession(guildId: string): Promise<void> {
  const userIds = await redisClient.smembers(speakerIdsKey(guildId));
  const keys = [
    sessionKey(guildId),
    speakerIdsKey(guildId),
    usageBreakdownKey(guildId),
    ...userIds.map((userId) => speakerKey(guildId, userId)),
  ];
  await redisClient.del(...keys);
}

export async function setSourceLang(guildId: string, lang: string): Promise<boolean> {
  if (!(await sessionExists(guildId))) return false;

  await redisClient.hset(sessionKey(guildId), 'sourceLang', lang);
  logger.info({ guildId, sourceLang: lang }, `guild ${guildId} source language set to: ${lang}`);
  return true;
}

export async function setTargetLang(guildId: string, lang: string): Promise<boolean> {
  const key = sessionKey(guildId);
  const data = await redisClient.hgetall(key);
  if (Object.keys(data).length === 0) return false;

  // 2026-08-26：target 也从笼统基础码扩成具体 locale（如 'en-IN'/'pt-BR'，见
  // commands/language-choices.js），跟 sourceLang 那次扩展是同一个理由（供应商按地区
  // 细分，翻译 prompt 直接吃 locale 能拿到更准的地区措辞，比如 en-US 的 "color" vs
  // en-GB 的 "colour"，见 translation-prompt.js）。但 TTS_PROVIDER_BY_LANG 这张表
  // 只按基础语言码分供应商（不区分地区——没有哪个供应商是"只覆盖 en-IN 不覆盖 en-US"
  // 这种颗粒度），查表前必须先还原成基础码，不能直接拿 locale 去查会全部查不到。
  const ttsProvider = resolveTtsProvider(toBaseLang(lang)!);
  await redisClient.hset(key, 'targetLang', lang);
  if (ttsProvider) {
    await redisClient.hset(key, 'ttsProvider', ttsProvider);
  } else {
    await redisClient.hdel(key, 'ttsProvider');
  }

  if (data.targetLang !== lang || data.ttsProvider !== ttsProvider) {
    await clearSpeakerVoices(guildId);
  }

  logger.info(
    { guildId, targetLang: lang, ttsProvider: ttsProvider ?? null },
    `guild ${guildId} target language set to: ${lang}, TTS provider: ${ttsProvider ?? '(none - this language has no voice, translated text only)'}`,
  );
  return true;
}

export async function setGame(guildId: string, gameId: string): Promise<boolean> {
  if (!(await sessionExists(guildId))) return false;

  await redisClient.hset(sessionKey(guildId), 'game', gameId);
  logger.info({ guildId, game: gameId }, `guild ${guildId} game set to: ${gameId}`);
  return true;
}

export async function resetSessionSettings(guildId: string): Promise<boolean> {
  if (!(await sessionExists(guildId))) return false;

  await redisClient.hdel(sessionKey(guildId), 'sourceLang', 'targetLang', 'ttsProvider', 'game');
  await clearSpeakerVoices(guildId);
  logger.info({ guildId }, `guild ${guildId} settings reset (source/target language, TTS provider, game selection back to initial state)`);
  return true;
}

export async function addSpeaker(guildId: string, userId: string, speakerState: SpeakerState): Promise<boolean> {
  if (!(await sessionExists(guildId))) {
    logger.warn({ guildId, userId }, `cannot assign speaker for ${userId} because guild session is missing`);
    return false;
  }

  const sequence = await redisClient.hincrby(sessionKey(guildId), 'speakerSeq', 1);
  speakerState.label = `Speaker${sequence}`;
  await saveSpeaker(guildId, userId, speakerState);
  logger.info({ guildId, userId, who: speakerState.label }, `${userId} assigned to ${speakerState.label}`);
  return true;
}

export async function saveSpeaker(guildId: string, userId: string, speakerState: SpeakerState): Promise<void> {
  if (!(await sessionExists(guildId))) return;

  const key = speakerKey(guildId, userId);
  await redisClient.sadd(speakerIdsKey(guildId), userId);
  await redisClient.del(key);
  const data = speakerHash(speakerState);
  if (Object.keys(data).length > 0) {
    await redisClient.hset(key, data);
  }
}

export async function nextPlaybackSequence(guildId: string): Promise<number | null> {
  if (!(await sessionExists(guildId))) return null;

  const next = await redisClient.hincrby(sessionKey(guildId), 'playbackSeq', 1);
  return next - 1;
}

export async function getSpeaker(guildId: string, userId: string): Promise<SpeakerState | undefined> {
  const data = await redisClient.hgetall(speakerKey(guildId, userId));
  return Object.keys(data).length > 0 ? fromSpeakerHash(data) : undefined;
}

export async function hasSpeaker(guildId: string, userId: string): Promise<boolean> {
  return (await redisClient.sismember(speakerIdsKey(guildId), userId)) === 1;
}

export async function listSpeakerEntries(guildId: string): Promise<Array<[string, SpeakerState]>> {
  return Array.from((await readSpeakers(guildId)).entries());
}

export async function listSpeakers(guildId: string): Promise<SpeakerState[]> {
  return Array.from((await readSpeakers(guildId)).values());
}

// Billing 每日限额提醒去重（见 billing-service.js 的 checkSttAllowed/checkTranslateAllowed）：
// 字段存的是"上次发过这条提醒的时间戳"，不是布尔值——每次检查时把它的 UTC 日期跟
// todayUtc() 比较，发现已经跨天了就当作没发过（先清掉这个字段，再走跟"从没发过"完全
// 一样的判断逻辑）。放在 session 的 Redis hash 上而不是单独的字段/Session 接口里，是
// 因为这纯粹是 billing-service.js 内部用的去重标记，其它读 session 的地方不需要关心它。
type BillingNotificationField = 'billingWarnedAt' | 'billingBlockedNotifiedAt' | 'sttBlockedNotifiedAt';

export async function shouldSendBillingNotification(guildId: string, field: BillingNotificationField): Promise<boolean> {
  const key = sessionKey(guildId);
  const sentAt = await redisClient.hget(key, field);
  if (!sentAt) return true;

  if (sentAt.slice(0, 10) !== todayUtc()) {
    // 跨天了，清空旧标记，当作今天还没发过
    await redisClient.hdel(key, field);
    return true;
  }

  return false;
}

export async function markBillingNotificationSent(guildId: string, field: BillingNotificationField): Promise<void> {
  await redisClient.hset(sessionKey(guildId), field, new Date().toISOString());
}

// /join 时（voice-listener.js 的 startListening）从 Postgres 读一次账号状态/套餐/
// 今天已用量，写进 Redis session hash——之后整场会话的账单判断（checkSttAllowed/
// checkTranslateAllowed）都只读这份缓存，不再查库。usageDate 记成 todayUtc()，
// 之后每次用量累加前用 ensureUsageDateCurrent 检查是否需要跨天重置。
export async function hydrateBillingState(
  guildId: string,
  state: { planId: string; accountStatus: string; sttSecondsUsedToday: number; textCharsUsedToday: number },
): Promise<void> {
  await redisClient.hset(sessionKey(guildId), {
    planId: state.planId,
    accountStatus: state.accountStatus,
    sttSecondsUsedToday: String(state.sttSecondsUsedToday),
    textCharsUsedToday: String(state.textCharsUsedToday),
    usageDate: todayUtc(),
  });
}

// 用量计数器只增不减，HINCRBYFLOAT/HINCRBY 天然原子，不需要额外加锁（见 CLAUDE.md
// billing 重设计一节）——STT 时长/翻译字符数在 provider 调用真正返回之前都不知道
// 准确值，"先放行、超了下次才拦"是刻意的设计取舍，不是漏做校验。
export async function incrementSttSecondsUsed(guildId: string, seconds: number): Promise<number> {
  return redisClient.hincrbyfloat(sessionKey(guildId), 'sttSecondsUsedToday', seconds).then(Number);
}

export async function incrementTextCharsUsed(guildId: string, chars: number): Promise<number> {
  return redisClient.hincrby(sessionKey(guildId), 'textCharsUsedToday', chars);
}

// 跨天重置：把当前 sttSecondsUsedToday/textCharsUsedToday（属于 usageDate 那一天）清零，
// usageDate 更新成今天。调用方（billing-service.js 的 ensureUsageDateCurrent）负责在
// 清零之前，先把这两个数字同步进 daily_guild_usage 的 usageDate 那一行——不然跨天瞬间
// 那一小段用量会凭空丢失，见 CLAUDE.md「DB 保持 source of truth」。
export async function resetDailyUsageCounters(guildId: string): Promise<void> {
  await redisClient.hset(sessionKey(guildId), {
    sttSecondsUsedToday: '0',
    textCharsUsedToday: '0',
    usageDate: todayUtc(),
  });
}

// stage|provider|model 三段拼一个 field 前缀，同一个 metric（比如 promptTokens）在
// 同一个 provider/model 组合下用 HINCRBYFLOAT 原子累加——float 是因为 STT 秒数/成本
// 类的量本来就不是整数，用同一个命令类型比"数字类型用 HINCRBY、浮点类型用
// HINCRBYFLOAT"两套分支简单，HINCRBYFLOAT 对纯整数值一样准确。
function usageMetricField(stage: string, provider: string, model: string, metric: string): string {
  return `${stage}|${provider}|${model}|${metric}`;
}

export async function accumulateSessionUsage(
  guildId: string,
  stage: string,
  provider: string,
  model: string,
  metrics: Record<string, number | undefined>,
): Promise<void> {
  const key = usageBreakdownKey(guildId);
  await Promise.all(
    Object.entries(metrics)
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] !== 0)
      .map(([metric, value]) => redisClient.hincrbyfloat(key, usageMetricField(stage, provider, model, metric), value)),
  );
}

export interface UsageBreakdownGroup {
  stage: string;
  provider: string;
  model: string;
  metrics: Record<string, number>;
}

// /leave 时（billing-service.js 的 finalizeSessionLedger）读一次，把扁平的
// "stage|provider|model|metric -> 数值" 字段还原成按 (stage, provider, model) 分组的
// 结构，喂给 cost-calculator.js 复用 provider_prices 定价逻辑算这场会话的总成本。
export async function readSessionUsageBreakdown(guildId: string): Promise<UsageBreakdownGroup[]> {
  const data = await redisClient.hgetall(usageBreakdownKey(guildId));
  const groups = new Map<string, UsageBreakdownGroup>();

  for (const [field, rawValue] of Object.entries(data)) {
    const [stage, provider, model, metric] = field.split('|');
    if (!stage || !provider || !model || !metric) continue;
    const groupKey = `${stage}|${provider}|${model}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = { stage, provider, model, metrics: {} };
      groups.set(groupKey, group);
    }
    group.metrics[metric] = Number(rawValue);
  }

  return Array.from(groups.values());
}

export async function clearSessionUsageBreakdown(guildId: string): Promise<void> {
  await redisClient.del(usageBreakdownKey(guildId));
}
