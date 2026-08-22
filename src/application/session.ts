import type { Gender } from '../domain/pitch.js';
import { redisClient } from '../adapter/out/redis/client.js';
import { createLogger } from '../adapter/out/logger.js';
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
  if (!(await sessionExists(guildId))) return false;

  const sequence = await redisClient.hincrby(sessionKey(guildId), 'speakerSeq', 1);
  speakerState.label = `Speaker${sequence}`;
  await saveSpeaker(guildId, userId, speakerState);
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
