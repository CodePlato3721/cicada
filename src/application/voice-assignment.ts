import { getVoicesByGender } from './ports/tts.js';
import type { Gender } from '../domain/pitch.js';

export function assignVoice(gender: Gender, usedVoices: Set<string>, provider: string, lang: string): string {
  const voicesByGender = getVoicesByGender(provider, lang);
  const allVoicesForLang = [...(voicesByGender.male ?? []), ...(voicesByGender.female ?? [])];
  const pool = voicesByGender[gender as 'male' | 'female'] ?? allVoicesForLang;

  if (pool.length === 0) {
    throw new Error(`No voices configured for provider "${provider}" language "${lang}"`);
  }

  const available = pool.filter((voice) => !usedVoices.has(voice));
  const candidates = available.length > 0 ? available : pool;

  return candidates[Math.floor(Math.random() * candidates.length)];
}
