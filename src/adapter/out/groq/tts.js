import { getGroqClient } from './client.js';

// Groq 控制台没有给这几个声音标官方性别，这里按名字的常见性别印象分组，
// 没有逐个试听验证过——如果听感不对，直接调整这两个数组，不影响其他逻辑
// （用它的地方是 application/voice-assignment.js）。
//
// 这个 provider 目前没有被 ports/tts.js 的 TTS_PROVIDER_BY_LANG 路由到任何语言，
// 是切到 Deepgram 之前的遗留代码，不是活跃供应商（见 CLAUDE.md）。这里按语言分组只是
// 为了跟 azure/deepgram 两个 adapter 的接口保持一致（ports/tts.js 的 getVoicesByGender
// 现在统一要求 provider 提供 VOICES_BY_LANG_AND_GENDER，不这么分的话，万一以后真被
// 路由到，会直接拿到空对象崩掉）——不确定这几个音色是不是真的能同时读英语和阿拉伯语
// （model 名字是 "canopylabs/orpheus-v1-english"，字面看更像只支持英语，`ar` 这个
// TTS_SUPPORTED_LANGS 条目本身可能就不准确），两个语言先复用同一批音色名，等真要启用
// 这个供应商时再重新核实。
export const VOICES_BY_LANG_AND_GENDER = {
  en: { male: ['austin', 'daniel', 'troy'], female: ['diana', 'hannah', 'autumn'] },
  ar: { male: ['austin', 'daniel', 'troy'], female: ['diana', 'hannah', 'autumn'] },
};

// 两个语言复用同一批音色名，flatMap 会产出重复项——去重（en/ar 场景下都合法，
// 单纯是名字撞了，不是数据错误）。
export const VALID_VOICES = [
  ...new Set(
    Object.values(VOICES_BY_LANG_AND_GENDER).flatMap((byGender) => [...byGender.male, ...byGender.female]),
  ),
];

// Orpheus 目前只支持这两种语言（CLAUDE.md 里记的已知限制）。
export const TTS_SUPPORTED_LANGS = ['en', 'ar'];

// text: 待合成文本（英语/阿拉伯语，Orpheus 目前只支持这两种）。
// 返回 wav 格式的 Buffer（Groq 这个模型固定只吐 wav，24kHz 单声道 16-bit）。
export async function synthesize(text, { voice = 'autumn' } = {}) {
  if (!VALID_VOICES.includes(voice)) {
    throw new Error(`voice 必须是以下之一：${VALID_VOICES.join(', ')}`);
  }

  const groq = getGroqClient();

  const response = await groq.audio.speech.create({
    input: text,
    model: 'canopylabs/orpheus-v1-english',
    voice,
    response_format: 'wav',
  });

  return Buffer.from(await response.arrayBuffer());
}
