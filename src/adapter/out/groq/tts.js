import { getGroqClient } from './client.js';

// Groq 控制台没有给这几个声音标官方性别，这里按名字的常见性别印象分组，
// 没有逐个试听验证过——如果听感不对，直接调整这两个数组，不影响其他逻辑
// （用它的地方是 application/voice-assignment.js）。
export const VOICES_BY_GENDER = {
  male: ['austin', 'daniel', 'troy'],
  female: ['diana', 'hannah', 'autumn'],
};

export const VALID_VOICES = [...VOICES_BY_GENDER.male, ...VOICES_BY_GENDER.female];

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
