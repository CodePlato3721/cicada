import { openStream as deepgramOpenStream } from '../../adapter/out/deepgram/stt.js';
import { openStream as groqOpenStream } from '../../adapter/out/groq/stt.js';
import { createLogger } from '../../adapter/out/logger.js';

const logger = createLogger('ports/stt');

// STT 端口：契约从"pre-recorded 整段转写"（transcribe(filePath, options) => Promise<TranscribeResult>）
// 换成流式（open/pushChunk/close）——VAD 判定一句话开始时 open 一路连接，说话过程中
// pushChunk 把 PCM 边到边推过去（不等一句话说完），VAD 判定这句话结束时 close()，
// resolve 出最终转写结果。目的是省掉"整句说完 → 落盘 → 整段发送 → 等响应"这段串行
// 等待，边界一确定就能立刻拿到结果。pipeline.js 只用得到返回值的 .text 字段，其他
// 字段（language/duration 等）不保证跨供应商一致。
export interface TranscribeOptions {
  language?: string;
  prompt?: string;
  // STT 供应商相关的识别关键词增强（目前只有 Deepgram 的 keyterm prompting 用得上，
  // 见 adapter/out/deepgram/stt.ts）——传一批当前游戏黑话的源语言词形，让识别阶段
  // 对这些生僻/专有名词加权，而不是等转写完了再做后处理纠错（术语库 applyTerminology
  // 那层做不到"STT 直接把整个词吞掉、换成别的常见字"这种情况，见 CCD-3 期间的实测：
  // "打野"被识别成孤立的"也"，术语库变体匹配对这种情况无能为力，只能从识别源头加权）。
  // 不是所有供应商都支持这个概念，不支持的可以直接忽略这个字段。
  keyterms?: string[];
}

export interface TranscribeResult {
  text: string;
  language?: string;
  usage?: {
    provider: string;
    model: string;
    audioDurationSec?: number;
    audioBytes?: number;
    chunkCount?: number;
    elapsedMs?: number;
  };
  [key: string]: unknown;
}

export interface SttStream {
  pushChunk(chunk: Buffer): void;
  close(): Promise<TranscribeResult>;
}

export type OpenStreamFn = (options?: TranscribeOptions) => SttStream;

// groq/stt.ts 现在也符合这次流式契约的形状了（TASK-04）——但按 DESIGN.md 的说明，
// Groq 当前不是实际启用的供应商（.env 里 STT_PROVIDER=deepgram），没有必要实现真正
// 的流式：内部把 pushChunk 推进来的 PCM 攒起来，close() 时一次性打包成 wav 调旧的
// pre-recorded Whisper 接口，对外表现跟 deepgram 这边的真流式一致，但没有"边说边转录"
// 的延时收益。
const PROVIDERS: Record<string, OpenStreamFn> = {
  deepgram: deepgramOpenStream,
  groq: groqOpenStream,
};

// 默认值跟 .env.example 的实际默认保持一致（deepgram，不是旧版的 groq）——旧默认值
// 挑 groq 是因为那时 groq 是唯一/首个供应商，现在实际启用、真正拿到"边说边转录"这个
// 延时收益的是 deepgram（见 DESIGN.md），groq 只是接口形状兼容、不是推荐配置，
// 继续默认指向它没有意义。
const PROVIDER_NAME = process.env.STT_PROVIDER || 'deepgram';
const impl = PROVIDERS[PROVIDER_NAME];

if (!impl) {
  throw new Error(`Unknown STT_PROVIDER: "${PROVIDER_NAME}", options: ${Object.keys(PROVIDERS).join(', ')}`);
}

logger.info({ provider: PROVIDER_NAME }, `STT provider: ${PROVIDER_NAME}`);

export function openStream(options?: TranscribeOptions): SttStream {
  return impl(options);
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
