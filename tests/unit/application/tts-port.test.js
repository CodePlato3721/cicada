// ports/tts.js 里 resolveTtsProvider/getVoicesByGender/TTS_PROVIDER_BY_LANG 都是纯函数
// /静态数据，不涉及网络调用（真正打网络的是 synthesize()，这里不测它）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TTS_PROVIDER_BY_LANG,
  resolveTtsProvider,
  getVoicesByGender,
  PROVIDER_NAMES,
} from '../../../dist/application/ports/tts.js';

test('resolveTtsProvider：TTS_PROVIDER_BY_LANG 里登记过的语言返回对应供应商', () => {
  assert.equal(resolveTtsProvider('en'), 'deepgram');
  assert.equal(resolveTtsProvider('zh'), 'azure');
});

test('resolveTtsProvider：没有登记的语言返回 undefined', () => {
  assert.equal(resolveTtsProvider('xx'), undefined);
});

test('TTS_PROVIDER_BY_LANG：覆盖 54 种目标语言（2026-08-26 扩展，deepgram 7 个 + azure 47 个）', () => {
  assert.equal(Object.keys(TTS_PROVIDER_BY_LANG).length, 54);
});

test('getVoicesByGender：已知供应商+语言返回对应的音色池', () => {
  const voices = getVoicesByGender('azure', 'ko');
  assert.deepEqual(voices, { male: ['ko-KR-InJoonNeural'], female: ['ko-KR-SunHiNeural'] });
});

test('getVoicesByGender：供应商不认识这个语言就返回空对象', () => {
  assert.deepEqual(getVoicesByGender('deepgram', 'zh'), {});
});

test('getVoicesByGender：供应商本身不存在也返回空对象，不抛错', () => {
  assert.deepEqual(getVoicesByGender('not-a-provider', 'en'), {});
});

test('PROVIDER_NAMES：包含全部已注册的 TTS 供应商', () => {
  assert.deepEqual(new Set(PROVIDER_NAMES), new Set(['groq', 'deepgram', 'azure']));
});
