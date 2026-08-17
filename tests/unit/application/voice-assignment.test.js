// voice-assignment.js 的 assignVoice 是纯函数（不依赖外部 IO/网络），只吃
// ports/tts.js 里静态的音色路由表——用真实的 provider/lang 组合（deepgram/en、
// azure/zh）驱动测试，不需要 mock。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignVoice } from '../../../dist/application/voice-assignment.js';

test('assignVoice：按性别从对应语言的音色池里选，不会选到别的语言/性别的音色', () => {
  const voice = assignVoice('male', new Set(), 'deepgram', 'en');
  assert.ok(voice.startsWith('aura-2-'));
  assert.ok(voice.endsWith('-en'));
});

test('assignVoice：gender=unknown 时从该语言全部音色（不分性别）里选', () => {
  const voice = assignVoice('unknown', new Set(), 'azure', 'zh');
  assert.ok(['zh-TW-YunJheNeural', 'zh-TW-HsiaoChenNeural', 'zh-TW-HsiaoYuNeural'].includes(voice));
});

test('assignVoice：优先避开已使用的音色', () => {
  // azure zh male 池只有一个音色（zh-TW-YunJheNeural），标记为已用后，
  // 池子里没有可用的了，应该退化成允许重复（还是返回这个唯一的音色，不报错）。
  const voice = assignVoice('male', new Set(['zh-TW-YunJheNeural']), 'azure', 'zh');
  assert.equal(voice, 'zh-TW-YunJheNeural');
});

test('assignVoice：female 池有多个候选时，会排除已用的那个', () => {
  const voice = assignVoice('female', new Set(['zh-TW-HsiaoChenNeural']), 'azure', 'zh');
  assert.equal(voice, 'zh-TW-HsiaoYuNeural');
});

test('assignVoice：供应商/语言组合下没有配置任何音色就抛错', () => {
  assert.throws(() => assignVoice('male', new Set(), 'deepgram', 'zh'), /No voices configured/);
});
