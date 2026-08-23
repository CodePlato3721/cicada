import type { Gender } from '../domain/pitch.js';
import { redisClient } from '../adapter/out/redis/client.js';
import { createLogger } from '../adapter/out/logger.js';
import { todayUtc } from '../domain/date.js';
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
  // "今天(UTC)已经被判定超出每日连接时长限额"的日期字符串，connection-usage-tracker.ts
  // 的定时打点跨过限额线时写入，billing-service.ts 的 checkBillingAllowed 每句话顺带
  // 读一次（不额外查询，见 checkBillingAllowed 的注释）。跟 todayUtc() 不相等就当没有。
  voiceLimitBlockedDate: string | undefined;
}

type SessionHash = Record<string, string>;

function sessionKey(guildId: string): string {
  return `session:guild:${guildId}`;
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
    voiceLimitBlockedDate: data.voiceLimitBlockedDate,
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
  await redisClient.hset(sessionKey(guildId), {
    speakerSeq: '0',
    playbackSeq: '0',
  });
  logger.info({ guildId }, `guild ${guildId} voice session created`);
  return fromSessionHash({ speakerSeq: '0', playbackSeq: '0' }, new Map());
}

export async function getSession(guildId: string): Promise<Session | undefined> {
  const data = await redisClient.hgetall(sessionKey(guildId));
  if (Object.keys(data).length === 0) return undefined;
  return fromSessionHash(data, await readSpeakers(guildId));
}

export async function deleteSession(guildId: string): Promise<void> {
  const userIds = await redisClient.smembers(speakerIdsKey(guildId));
  const keys = [sessionKey(guildId), speakerIdsKey(guildId), ...userIds.map((userId) => speakerKey(guildId, userId))];
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

  const ttsProvider = resolveTtsProvider(lang);
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

// Billing 每日限额提醒去重（见 billing-service.js 的 checkBillingAllowed）：字段存的是
// "上次发过这条提醒的时间戳"，不是布尔值——每次检查时把它的 UTC 日期跟 todayUtc() 比较，
// 发现已经跨天了就当作没发过（先清掉这个字段，再走跟"从没发过"完全一样的判断逻辑）。
// 放在 session 的 Redis hash 上而不是单独的字段/Session 接口里，是因为这纯粹是
// billing-service.js 内部用的去重标记，其它读 session 的地方不需要关心它。
type BillingNotificationField = 'billingWarnedAt' | 'billingBlockedNotifiedAt';

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

// 每日连接时长限额（connection-usage-tracker.ts 的定时打点判定），标记本身就是个
// 日期字符串（不是布尔），逻辑比 billingWarnedAt 那对还简单——不需要主动清空，
// 直接跟 todayUtc() 比较是不是同一天就行，见 Session.voiceLimitBlockedDate 的注释。
export async function markVoiceLimitBlocked(guildId: string): Promise<void> {
  await redisClient.hset(sessionKey(guildId), 'voiceLimitBlockedDate', todayUtc());
}

export async function isVoiceLimitBlocked(guildId: string): Promise<boolean> {
  const value = await redisClient.hget(sessionKey(guildId), 'voiceLimitBlockedDate');
  return value === todayUtc();
}
