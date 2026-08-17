import { transcribe as groqTranscribe } from '../../adapter/out/groq/stt.js';
import { transcribe as deepgramTranscribe } from '../../adapter/out/deepgram/stt.js';
import { createLogger } from '../../adapter/out/logger.js';

const logger = createLogger('ports/stt');

// STT 端口：契约 transcribe(filePath, { language, prompt }) => Promise<{ text, ... }>，
// pipeline.js 只用得到返回值的 .text 字段，其他字段（language/duration 等）不保证跨供应商一致。
export interface TranscribeOptions {
  language?: string;
  prompt?: string;
}

export interface TranscribeResult {
  text: string;
  language?: string;
  [key: string]: unknown;
}

export type TranscribeFn = (filePath: string, options?: TranscribeOptions) => Promise<TranscribeResult>;

const PROVIDERS: Record<string, TranscribeFn> = {
  groq: groqTranscribe,
  deepgram: deepgramTranscribe,
};

const PROVIDER_NAME = process.env.STT_PROVIDER || 'groq';
const impl = PROVIDERS[PROVIDER_NAME];

if (!impl) {
  throw new Error(`Unknown STT_PROVIDER: "${PROVIDER_NAME}", options: ${Object.keys(PROVIDERS).join(', ')}`);
}

logger.info({ provider: PROVIDER_NAME }, `STT provider: ${PROVIDER_NAME}`);

export function transcribe(filePath: string, options?: TranscribeOptions): Promise<TranscribeResult> {
  return impl(filePath, options);
}

export const activeProvider = PROVIDER_NAME;

// 项目实际准备好处理的源语言——跟 /lang source: 手动能选的范围完全一致（见 lang.js
// 的 SOURCE_LANG_CHOICES，从这个数组派生，不是各自维护一份）。STT 供应商底层能识别的
// 语言远不止这几个（Deepgram Nova-3 支持 60+ 种），但术语库/翻译 prompt 这些下游环节
// 只按这几个语言设计过，自动检测(pipeline.js 的 handleSegment)锁定结果时要用这份白名单
// 过滤——检测结果不在这个范围内就当作"没检测出来"，不锁定，避免把极短音频误判出来的
// 冷门语言（实测出现过"hello hello"被判成 cs/捷克语）永久锁进整场会话，把后续所有
// 语音都往错的语言方向识别。
export const SUPPORTED_SOURCE_LANGS = ['zh', 'en', 'ko', 'ar'];
