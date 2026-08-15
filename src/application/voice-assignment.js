import { getVoicesByGender, getValidVoices } from './ports/tts.js';

// 给一个新出现的说话人分配 TTS 音色：按检测到的性别选对应池子（'unknown' 就在全部音色里选），
// 优先避开这场会话里已经在用的音色，尽量保证"一耳朵能听出是不同的人"；
// 池子用完（同性别说话人比声音种类还多）就允许重复，退化但不报错——
// 音色只求区分度，不追求每个人都独一无二。
//
// provider 现在是必传参数——不同 TTS 供应商的音色命名空间完全不通用（Deepgram 是
// "aura-2-xxx-en" 这种，Azure 是 "zh-TW-XxxNeural" 这种），选音色池子必须知道是从
// 哪个供应商的池子里选，调用方（pipeline.js）按 session.ttsProvider 传进来。
export function assignVoice(gender, usedVoices, provider) {
  const voicesByGender = getVoicesByGender(provider);
  const validVoices = getValidVoices(provider);
  const pool = voicesByGender[gender] ?? validVoices;
  const available = pool.filter((voice) => !usedVoices.has(voice));
  const candidates = available.length > 0 ? available : pool;

  return candidates[Math.floor(Math.random() * candidates.length)];
}
