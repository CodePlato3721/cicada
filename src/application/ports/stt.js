import { transcribe as groqTranscribe } from '../../adapter/out/groq/stt.js';
import { transcribe as deepgramTranscribe } from '../../adapter/out/deepgram/stt.js';

// STT 端口：契约 transcribe(filePath, { language, prompt }) => Promise<{ text, ... }>，
// pipeline.js 只用得到返回值的 .text 字段，其他字段（language/duration 等）不保证跨供应商一致。
const PROVIDERS = {
  groq: groqTranscribe,
  deepgram: deepgramTranscribe,
};

const PROVIDER_NAME = process.env.STT_PROVIDER || 'groq';
const impl = PROVIDERS[PROVIDER_NAME];

if (!impl) {
  throw new Error(`未知的 STT_PROVIDER: "${PROVIDER_NAME}"，可选：${Object.keys(PROVIDERS).join(', ')}`);
}

console.log(`[ports/stt] STT 供应商：${PROVIDER_NAME}`);

export function transcribe(filePath, options) {
  return impl(filePath, options);
}

export const activeProvider = PROVIDER_NAME;
