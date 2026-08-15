import { getVoicesByGender } from './ports/tts.js';

// 给一个新出现的说话人分配 TTS 音色：按检测到的性别选对应池子（'unknown' 就在这个
// 语言下的全部音色里选），优先避开这场会话里已经在用的音色，尽量保证"一耳朵能听出是
// 不同的人"；池子用完（同性别说话人比声音种类还多）就允许重复，退化但不报错——
// 音色只求区分度，不追求每个人都独一无二。
//
// provider 和 lang 现在都是必传参数：
// - provider：不同 TTS 供应商的音色命名空间完全不通用（Deepgram 是"aura-2-xxx-en"
//   这种，Azure 是"zh-TW-XxxNeural"这种）
// - lang：同一个供应商可能覆盖好几种语言（比如 deepgram 覆盖 en/fr/ja/de/es），只看
//   供应商不看语言会选出语言不匹配的音色（比如目标语言是中文却分配到葡萄牙语音色，
//   Azure 会返回一份没有实际内容的空音频）。调用方（pipeline.js）按当前
//   session.ttsProvider/targetLang 传进来。
export function assignVoice(gender, usedVoices, provider, lang) {
  const voicesByGender = getVoicesByGender(provider, lang);
  const allVoicesForLang = [...(voicesByGender.male ?? []), ...(voicesByGender.female ?? [])];
  const pool = voicesByGender[gender] ?? allVoicesForLang;

  if (pool.length === 0) {
    throw new Error(`供应商 "${provider}" 语言 "${lang}" 下没有配置任何音色`);
  }

  const available = pool.filter((voice) => !usedVoices.has(voice));
  const candidates = available.length > 0 ? available : pool;

  return candidates[Math.floor(Math.random() * candidates.length)];
}
