import { openStream as deepgramOpenStream } from '../../adapter/out/deepgram/stt.js';
import { openStream as groqOpenStream } from '../../adapter/out/groq/stt.js';
import { openStream as azureOpenStream } from '../../adapter/out/azure/stt.js';
import sttProviderConfig from '../../config/stt-providers.json' with { type: 'json' };

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
    keytermCount?: number;
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
  azure: azureOpenStream,
  deepgram: deepgramOpenStream,
  groq: groqOpenStream,
};

// 2026-08-26：STT 从"进程启动时用一个 provider 字段选定一个供应商、整个进程生命周期
// 都用它"改成跟 TTS 端口（ports/tts.js 的 TTS_PROVIDER_BY_LANG）同一个思路——按语言
// 路由到不同供应商，不是全局单一供应商。当前 stt-providers.json 里 79 个 locale 全部
// 指向 deepgram（这份 locale 全集本来就是照抄 Deepgram 官方支持范围，参见
// SUPPORTED_SOURCE_LANGS 上面的注释），跟改动前实际效果一致，但打开了"以后某个 locale
// 想换供应商，改 stt-providers.json 一条数据，不用改代码"的口子。
const STT_PROVIDER_BY_LANG: Record<string, string> = sttProviderConfig.sttProviders;

// 语言（这里是具体 locale，跟 SUPPORTED_SOURCE_LANGS 同一套码）-> 供应商名，没有映射
// 就落到 DEFAULT_PROVIDER——不像 TTS 那边"没有供应商就干脆不播报"是可接受的降级路径，
// STT 没转写出文字后面全链路都没法继续，没有对应的"跳过"语义，所以这里必须有兜底，
// 不能返回 undefined 让调用方自己处理。兜底也覆盖了 language 还没设置（用户还没
// /config 过）这种情况——沿用旧版本"不传 language 就走 detect_language"的行为
// （见 deepgram/stt.js 的 buildUrl）。
const DEFAULT_PROVIDER = 'deepgram';

export function resolveSttProvider(language: string | undefined): string {
  if (!language) return DEFAULT_PROVIDER;
  return STT_PROVIDER_BY_LANG[language] ?? DEFAULT_PROVIDER;
}

export function openStream(options: TranscribeOptions = {}): SttStream {
  const providerName = resolveSttProvider(options.language);
  const impl = PROVIDERS[providerName];
  if (!impl) {
    throw new Error(`Unknown STT provider: "${providerName}", options: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  return impl(options);
}

// 项目实际准备好处理的源语言——跟 /lang source: 手动能选的范围完全一致（见
// language-choices.js 的 SOURCE_LANG_CHOICES，从这个数组派生，不是各自维护一份）。
//
// 2026-08-26 再次扩展：不再是笼统的 ISO-639-1 基础码（'zh'/'en'/...），改成 Deepgram
// nova-3 实际支持的具体 BCP-47 locale 码全集（如 'zh-TW'/'en-US'/'ar-EG'）。跟上一版
// （zh/en/ko/ar/fr/ja/de/es/pt 九个基础码，跟 target 巧合对齐）不同——这次不再跟 target
// 对齐，target（见 ports/tts.js 的 TTS_PROVIDER_BY_LANG）还是 9 个基础码不变，因为
// TTS 播报不需要区分地区口音，但 STT 识别用具体地区 locale 能明显提升准确率（同一句英语，
// 'en-US' 跟 'en-IN' 的识别模型不是同一套）。这份列表就是 Deepgram 官方支持的全部
// STT locale，直接照抄，不是项目自己筛的子集——下游术语库/关键词检测按语言家族查表
// （不区分地区），查表前用 domain/language.js 的 toBaseLang() 把这里的具体 locale
// 还原成基础码，见 terminology.js/keyterms.js。
export const SUPPORTED_SOURCE_LANGS = [
  'af-ZA',
  'ar-AE', 'ar-SA', 'ar-QA', 'ar-KW', 'ar-SY', 'ar-LB', 'ar-PS', 'ar-JO', 'ar-EG', 'ar-SD', 'ar-TD', 'ar-MA', 'ar-DZ', 'ar-TN', 'ar-IQ', 'ar-IR',
  'hy', 'be', 'bn', 'bs', 'bg', 'ca',
  'zh-HK', 'zh-CN', 'zh-TW',
  'hr', 'cs',
  'da-DK',
  'nl',
  'en-US', 'en-AU', 'en-GB', 'en-IN', 'en-NZ',
  'et', 'fi',
  'nl-BE',
  'fr-CA',
  'ka-GE',
  'de', 'de-CH',
  'el',
  'gu-IN',
  'he', 'hi', 'hu', 'id', 'it', 'ja', 'kn',
  'ko-KR',
  'lv', 'lt', 'mk', 'ms', 'mr', 'ne', 'no', 'fa', 'pl',
  'pt-BR', 'pt-PT',
  'pa-IN',
  'ro', 'ru', 'sr', 'sk', 'sl',
  'es-419',
  'sv-SE',
  'tl', 'ta', 'te',
  'th-TH',
  'tr', 'uk', 'ur', 'vi',
];
