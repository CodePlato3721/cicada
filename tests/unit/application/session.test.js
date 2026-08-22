import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSession,
  getSession,
  deleteSession,
  setSourceLang,
  setTargetLang,
  setGame,
  resetSessionSettings,
  addSpeaker,
  nextPlaybackSequence,
  getSpeaker,
  hasSpeaker,
  listSpeakers,
  saveSpeaker,
} from '../../../dist/application/session.js';
import { ensureRedisReady, redisClient } from '../../../dist/adapter/out/redis/client.js';

after(() => {
  redisClient.disconnect();
});

before(async () => {
  await ensureRedisReady();
});

function freshGuildId() {
  return `test-guild-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

test('createSession creates an empty guild session in Redis', async () => {
  const guildId = freshGuildId();
  const session = await createSession(guildId);

  assert.equal(session.sourceLang, undefined);
  assert.equal(session.targetLang, undefined);
  assert.equal(session.ttsProvider, undefined);
  assert.equal(session.game, undefined);
  assert.equal(session.playbackSeq, 0);
  assert.equal('connection' in session, false);
  assert.equal('voiceChannel' in session, false);

  const stored = await getSession(guildId);
  assert.equal(stored?.sourceLang, undefined);
  assert.equal(stored?.targetLang, undefined);
  assert.equal(stored?.playbackSeq, 0);

  await deleteSession(guildId);
});

test('deleteSession removes the guild session', async () => {
  const guildId = freshGuildId();
  await createSession(guildId);
  await deleteSession(guildId);
  assert.equal(await getSession(guildId), undefined);
});

test('setters return false when the guild session does not exist', async () => {
  const guildId = freshGuildId();
  assert.equal(await setSourceLang(guildId, 'en'), false);
  assert.equal(await setTargetLang(guildId, 'en'), false);
  assert.equal(await setGame(guildId, 'whiteout'), false);
  assert.equal(await resetSessionSettings(guildId), false);
});

test('setTargetLang updates ttsProvider with the target language', async () => {
  const guildId = freshGuildId();
  await createSession(guildId);

  await setTargetLang(guildId, 'en');
  assert.equal((await getSession(guildId))?.targetLang, 'en');
  assert.equal((await getSession(guildId))?.ttsProvider, 'deepgram');

  await setTargetLang(guildId, 'zh');
  assert.equal((await getSession(guildId))?.ttsProvider, 'azure');

  await deleteSession(guildId);
});

test('setTargetLang clears assigned speaker voices when target changes', async () => {
  const guildId = freshGuildId();
  await createSession(guildId);
  await setTargetLang(guildId, 'en');
  const speaker = { voice: 'aura-2-atlas-en' };
  await addSpeaker(guildId, 'user-1', speaker);

  await setTargetLang(guildId, 'en');
  assert.equal((await getSpeaker(guildId, 'user-1'))?.voice, 'aura-2-atlas-en');

  await setTargetLang(guildId, 'zh');
  assert.equal((await getSpeaker(guildId, 'user-1'))?.voice, undefined);

  await deleteSession(guildId);
});

test('target languages without a TTS route clear ttsProvider', async () => {
  const guildId = freshGuildId();
  await createSession(guildId);

  await setTargetLang(guildId, 'xx');
  assert.equal((await getSession(guildId))?.ttsProvider, undefined);

  await deleteSession(guildId);
});

test('resetSessionSettings clears settings without removing speakers', async () => {
  const guildId = freshGuildId();
  await createSession(guildId);
  await setSourceLang(guildId, 'zh');
  await setTargetLang(guildId, 'en');
  await setGame(guildId, 'whiteout');
  await addSpeaker(guildId, 'user-1', { voice: 'aura-2-atlas-en' });

  await resetSessionSettings(guildId);

  const session = await getSession(guildId);
  assert.equal(session?.sourceLang, undefined);
  assert.equal(session?.targetLang, undefined);
  assert.equal(session?.ttsProvider, undefined);
  assert.equal(session?.game, undefined);
  assert.equal((await getSpeaker(guildId, 'user-1'))?.voice, undefined);
  assert.equal(await hasSpeaker(guildId, 'user-1'), true);

  await deleteSession(guildId);
});

test('addSpeaker assigns SpeakerN labels in order', async () => {
  const guildId = freshGuildId();
  await createSession(guildId);

  const speaker1 = {};
  const speaker2 = {};
  await addSpeaker(guildId, 'user-1', speaker1);
  await addSpeaker(guildId, 'user-2', speaker2);

  assert.equal(speaker1.label, 'Speaker1');
  assert.equal(speaker2.label, 'Speaker2');
  assert.deepEqual(await getSpeaker(guildId, 'user-1'), speaker1);
  assert.equal(await hasSpeaker(guildId, 'user-2'), true);
  assert.equal(await hasSpeaker(guildId, 'user-3'), false);
  assert.deepEqual(await listSpeakers(guildId), [speaker1, speaker2]);

  await deleteSession(guildId);
});

test('saveSpeaker persists later speaker mutations', async () => {
  const guildId = freshGuildId();
  await createSession(guildId);
  const speaker = {};
  await addSpeaker(guildId, 'user-1', speaker);

  speaker.gender = 'female';
  speaker.lastTranscript = 'hello';
  speaker.voice = 'aura-2-athena-en';
  await saveSpeaker(guildId, 'user-1', speaker);

  assert.deepEqual(await getSpeaker(guildId, 'user-1'), speaker);

  await deleteSession(guildId);
});

test('listSpeakers/hasSpeaker handle missing guilds', async () => {
  const guildId = freshGuildId();
  assert.deepEqual(await listSpeakers(guildId), []);
  assert.equal(await hasSpeaker(guildId, 'user-1'), false);
  assert.equal(await getSpeaker(guildId, 'user-1'), undefined);
});

test('nextPlaybackSequence increments atomically from zero', async () => {
  const guildId = freshGuildId();
  await createSession(guildId);

  assert.equal(await nextPlaybackSequence(guildId), 0);
  assert.equal(await nextPlaybackSequence(guildId), 1);
  assert.equal(await nextPlaybackSequence(guildId), 2);
  assert.equal(await nextPlaybackSequence(freshGuildId()), null);

  await deleteSession(guildId);
});
