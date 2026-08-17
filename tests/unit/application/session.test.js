// session.js 是纯内存状态管理（一个 Map，没有 IO/网络），可以直接驱动公开 API 测试。
// connection/voiceChannel 只是原样存进去、不被 session.js 自己读取内容，这里用最简单
// 的占位对象即可，不需要真的连 Discord。
import { test } from 'node:test';
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
} from '../../../dist/application/session.js';

const FAKE_CONNECTION = {};
const FAKE_VOICE_CHANNEL = {};

function freshGuildId() {
  // 每个 test 用独立的 guildId，避免 session.js 模块级 Map 里的状态跨用例互相污染。
  return `guild-${Math.random().toString(36).slice(2)}`;
}

test('createSession：初始状态没有默认的源/目标语言，游戏默认第一项（whiteout）', () => {
  const guildId = freshGuildId();
  const session = createSession(guildId, FAKE_CONNECTION, FAKE_VOICE_CHANNEL);

  assert.equal(session.sourceLang, undefined);
  assert.equal(session.targetLang, undefined);
  assert.equal(session.ttsProvider, undefined);
  assert.equal(session.game, 'whiteout');
  assert.equal(session.playbackSeq, 0);
  assert.equal(getSession(guildId), session);
});

test('deleteSession：删除后 getSession 返回 undefined', () => {
  const guildId = freshGuildId();
  createSession(guildId, FAKE_CONNECTION, FAKE_VOICE_CHANNEL);
  deleteSession(guildId);
  assert.equal(getSession(guildId), undefined);
});

test('setSourceLang/setTargetLang：guild 不存在（没 /join）时返回 false', () => {
  const guildId = freshGuildId();
  assert.equal(setSourceLang(guildId, 'en'), false);
  assert.equal(setTargetLang(guildId, 'en'), false);
  assert.equal(setGame(guildId, 'whiteout'), false);
  assert.equal(resetSessionSettings(guildId), false);
});

test('setTargetLang：联动设置 ttsProvider，目标语言有路由就跟着变', () => {
  const guildId = freshGuildId();
  createSession(guildId, FAKE_CONNECTION, FAKE_VOICE_CHANNEL);

  setTargetLang(guildId, 'en');
  assert.equal(getSession(guildId).targetLang, 'en');
  assert.equal(getSession(guildId).ttsProvider, 'deepgram');

  setTargetLang(guildId, 'zh');
  assert.equal(getSession(guildId).ttsProvider, 'azure');
});

test('setTargetLang：目标语言没有 TTS 供应商时，ttsProvider 是 undefined', () => {
  const guildId = freshGuildId();
  createSession(guildId, FAKE_CONNECTION, FAKE_VOICE_CHANNEL);

  setTargetLang(guildId, 'xx');
  assert.equal(getSession(guildId).ttsProvider, undefined);
});

test('resetSessionSettings：恢复成 createSession 时的初始状态，不动 speakers', () => {
  const guildId = freshGuildId();
  createSession(guildId, FAKE_CONNECTION, FAKE_VOICE_CHANNEL);
  setSourceLang(guildId, 'zh');
  setTargetLang(guildId, 'en');
  setGame(guildId, 'whiteout');
  addSpeaker(guildId, 'user-1', {});

  resetSessionSettings(guildId);

  const session = getSession(guildId);
  assert.equal(session.sourceLang, undefined);
  assert.equal(session.targetLang, undefined);
  assert.equal(session.ttsProvider, undefined);
  assert.equal(session.game, 'whiteout');
  assert.equal(hasSpeaker(guildId, 'user-1'), true); // speakers 不受 reset 影响
});

test('addSpeaker：按加入顺序分配"SpeakerN"标签', () => {
  const guildId = freshGuildId();
  createSession(guildId, FAKE_CONNECTION, FAKE_VOICE_CHANNEL);

  const speaker1 = {};
  const speaker2 = {};
  addSpeaker(guildId, 'user-1', speaker1);
  addSpeaker(guildId, 'user-2', speaker2);

  assert.equal(speaker1.label, 'Speaker1');
  assert.equal(speaker2.label, 'Speaker2');
  assert.equal(getSpeaker(guildId, 'user-1'), speaker1);
  assert.equal(hasSpeaker(guildId, 'user-2'), true);
  assert.equal(hasSpeaker(guildId, 'user-3'), false);
  assert.deepEqual([...listSpeakers(guildId)], [speaker1, speaker2]);
});

test('listSpeakers/hasSpeaker：guild 不存在时分别返回空迭代和 false', () => {
  const guildId = freshGuildId();
  assert.deepEqual([...listSpeakers(guildId)], []);
  assert.equal(hasSpeaker(guildId, 'user-1'), false);
  assert.equal(getSpeaker(guildId, 'user-1'), undefined);
});

test('nextPlaybackSequence：guild 存在时严格递增，从 0 开始；guild 不存在返回 null', () => {
  const guildId = freshGuildId();
  createSession(guildId, FAKE_CONNECTION, FAKE_VOICE_CHANNEL);

  assert.equal(nextPlaybackSequence(guildId), 0);
  assert.equal(nextPlaybackSequence(guildId), 1);
  assert.equal(nextPlaybackSequence(guildId), 2);
  assert.equal(nextPlaybackSequence(freshGuildId()), null);
});
