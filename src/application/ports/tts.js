import * as groq from '../../adapter/out/groq/tts.js';
import * as deepgram from '../../adapter/out/deepgram/tts.js';

// TTS 端口：契约 synthesize(text, { voice, targetLang }) => Promise<Buffer>（wav）。
// 除了合成函数本身，还把当前 provider 的音色目录（VOICES_BY_GENDER/VALID_VOICES）和
// 支持的目标语言列表一并暴露出来——这两样每个供应商都不一样，voice-assignment.js 和
// pipeline.js 只认这个端口，不用关心具体是谁。
const PROVIDERS = { groq, deepgram };

const PROVIDER_NAME = process.env.TTS_PROVIDER || 'groq';
const impl = PROVIDERS[PROVIDER_NAME];

if (!impl) {
  throw new Error(`未知的 TTS_PROVIDER: "${PROVIDER_NAME}"，可选：${Object.keys(PROVIDERS).join(', ')}`);
}

console.log(`[ports/tts] TTS 供应商：${PROVIDER_NAME}`);

export function synthesize(text, options) {
  return impl.synthesize(text, options);
}

export const VOICES_BY_GENDER = impl.VOICES_BY_GENDER;
export const VALID_VOICES = impl.VALID_VOICES;
export const TTS_SUPPORTED_LANGS = impl.TTS_SUPPORTED_LANGS;
export const activeProvider = PROVIDER_NAME;
