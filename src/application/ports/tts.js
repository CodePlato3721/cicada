import * as groq from '../../adapter/out/groq/tts.js';
import * as deepgram from '../../adapter/out/deepgram/tts.js';
import * as azure from '../../adapter/out/azure/tts.js';

// TTS 端口：不像 STT/翻译端口那样"进程启动时用一个 PROVIDER 环境变量选定一个供应商、
// 整个进程生命周期都用它"——因为不同目标语言要用不同供应商才能真的出声音（各家 TTS
// 模型的语言覆盖范围不一样，没有一个供应商能覆盖这个项目要的全部目标语言）。这里是一个
// 真正可插拔的多供应商注册表，具体用哪个供应商由调用方每次显式传 provider 参数决定
// （见 session.js 的 ttsProvider 字段，随 /lang target: 变化联动更新）。
const PROVIDERS = { groq, deepgram, azure };

// 目标语言 -> 该用哪个 TTS 供应商播报。这张表是"目标语言实际能不能出声音"的唯一权威
// 判断依据——一个目标语言不在这张表里，就算翻译文字正常生成了，也不会有语音播报
// （pipeline.js 会打日志说明这一点，不是静默失败）。
export const TTS_PROVIDER_BY_LANG = {
  en: 'deepgram',
  fr: 'deepgram',
  ja: 'deepgram',
  de: 'deepgram',
  es: 'deepgram',
  zh: 'azure',
  ko: 'azure',
  pt: 'azure',
  ar: 'azure',
};

// 目标语言 -> 供应商名（字符串），没有映射就返回 undefined——调用方（session.js）据此
// 判断"这个目标语言到底有没有 TTS 供应商能播"。
export function resolveTtsProvider(targetLang) {
  return TTS_PROVIDER_BY_LANG[targetLang];
}

// provider 由调用方显式传入（不再有"当前唯一激活的供应商"这个全局概念）。
export function synthesize(text, { voice, targetLang, provider }) {
  const impl = PROVIDERS[provider];
  if (!impl) {
    throw new Error(`未知的 TTS provider: "${provider}"，可选：${Object.keys(PROVIDERS).join(', ')}`);
  }
  return impl.synthesize(text, { voice, targetLang });
}

// voice-assignment.js 按性别分配音色时，要先知道"这个供应商有哪些音色可选"——
// 跟 synthesize 一样，provider 从调用方传入，不是模块级别定死的。
export function getVoicesByGender(provider) {
  return PROVIDERS[provider]?.VOICES_BY_GENDER ?? {};
}

export function getValidVoices(provider) {
  return PROVIDERS[provider]?.VALID_VOICES ?? [];
}

export const PROVIDER_NAMES = Object.keys(PROVIDERS);
