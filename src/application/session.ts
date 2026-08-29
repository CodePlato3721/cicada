import type { Gender } from '../domain/pitch.js';
import { redisClient } from '../adapter/out/redis/client.js';
import { createLogger } from '../adapter/out/logger.js';
import { todayUtc } from '../domain/date.js';
import { resolveTtsProvider } from './ports/tts.js';
import { DEFAULT_PLAN_ID } from './billing/plans.js';

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
  planId: string;
  accountStatus: string;
  sttSecondsUsedToday: number;
  textCharsUsedToday: number;
  usageDate: string | undefined;
  sessionStartedAt: string | undefined;
}

type SessionHash = Record<string, string>;

function sessionKey(guildId: string): string {
  return `session:guild:${guildId}`;
}

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
    planId: data.planId ?? DEFAULT_PLAN_ID,
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

type BillingNotificationField = 'billingWarnedAt' | 'billingBlockedNotifiedAt' | 'sttBlockedNotifiedAt';

export async function shouldSendBillingNotification(guildId: string, field: BillingNotificationField): Promise<boolean> {
  const key = sessionKey(guildId);
  const sentAt = await redisClient.hget(key, field);
  if (!sentAt) return true;

  if (sentAt.slice(0, 10) !== todayUtc()) {
    await redisClient.hdel(key, field);
    return true;
  }

  return false;
}

export async function markBillingNotificationSent(guildId: string, field: BillingNotificationField): Promise<void> {
  await redisClient.hset(sessionKey(guildId), field, new Date().toISOString());
}

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

export async function incrementSttSecondsUsed(guildId: string, seconds: number): Promise<number> {
  return redisClient.hincrbyfloat(sessionKey(guildId), 'sttSecondsUsedToday', seconds).then(Number);
}

export async function incrementTextCharsUsed(guildId: string, chars: number): Promise<number> {
  return redisClient.hincrby(sessionKey(guildId), 'textCharsUsedToday', chars);
}

export async function resetDailyUsageCounters(guildId: string): Promise<void> {
  await redisClient.hset(sessionKey(guildId), {
    sttSecondsUsedToday: '0',
    textCharsUsedToday: '0',
    usageDate: todayUtc(),
  });
}

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
