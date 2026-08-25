import type { SynthesizeOptions, VoicesByGender } from '../../../application/ports/tts.js';
import { postJsonForAudio } from './client.js';
import { createLogger } from '../logger.js';
import { buildTtsUsageFields } from '../usage-log.js';
import { recordExternalApiUsage } from '../../../application/billing/billing-service.js';
import voiceCatalog from '../../../config/tts-voices-deepgram.json' with { type: 'json' };

const logger = createLogger('deepgram/tts');

// 官方音色列表明确标了性别（不是我们猜的），来源：developers.deepgram.com/docs/tts-models。
// 2026-08-25 核对过一次官方页面，按当时的完整目录填的（en 41 个、es 17 个、de 7 个、
// fr 2 个、ja 5 个，fr 从一开始就只有一男一女，不是我们没填全）——Deepgram 之后如果
// 又加了新音色，这份文件不会自动跟着涨，需要人工再对一次官方页面。
// nl/it 这两个 Aura-2 也支持、目录也一并抄了过来，但 TTS_PROVIDER_BY_LANG 目前没有
// 任何目标语言路由到它们（见 ports/tts.js），纯粹是"能力已经具备、还没启用"，不代表
// 产品已经支持这两个目标语言——真要开放 nl/it 目标语言，还要过翻译/术语库那些下游环节。
//
// 数据本身放在 tts-voices-deepgram.json，不再内联成 TS 字面量——按"语言 -> 性别"两层
// 分组，不是"性别 -> 全部语言混一起"（之前是后者，一个 female 数组把 25 个英文音色和
// es/de/fr/ja 各一个音色全部塞在一起，assignVoice 按性别随机挑的时候完全不知道要念哪种
// 语言，随机抽中的音色语言跟目标语言对不上会导致播报异常——实测在 azure/tts.js 那边
// 踩到了这个坑，这里是同一个模式）。跟 azure/tts.ts 的 tts-voices-azure.json 是同一个
// 结构（Record<语言, VoicesByGender>，没有外层供应商名包裹键），两边用同一种方式把
// JSON import 当 VOICES_BY_LANG_AND_GENDER 用。
export const VOICES_BY_LANG_AND_GENDER: Record<string, VoicesByGender> = voiceCatalog;

// 提供给 synthesize() 内部校验用的扁平列表——校验"这是不是本供应商认识的音色"这件事
// 不需要知道语言，一个 provider 级别的合法音色集合就够了，跟 VOICES_BY_LANG_AND_GENDER
// 各自服务不同的目的（一个用于按语言分配音色，一个用于校验音色合法性）。
export const VALID_VOICES: string[] = Object.values(VOICES_BY_LANG_AND_GENDER).flatMap((byGender) => [
  ...(byGender.male ?? []),
  ...(byGender.female ?? []),
]);

// 这份列表是"这个 adapter 目前备了音色的语言"，不等于"TTS_PROVIDER_BY_LANG 实际路由过来
// 的语言"——nl/it 有音色但没被路由（见上面的说明）。没有任何代码读取这个常量做校验
// （CLAUDE.md 里也提过，故意没加这层防御），纯粹是给人看的文档。
export const TTS_SUPPORTED_LANGS = ['en', 'es', 'de', 'fr', 'ja', 'nl', 'it'];

// text: 待合成文本。voice: 上面列表里的一个 model 名。
// 返回 wav Buffer，跟 groq/tts.js 的 synthesize() 返回形状一致——响应直接就是音频字节，
// 不像 Qwen 那样还要多一次下载。
export async function synthesize(
  text: string,
  { voice = 'aura-2-thalia-en', logContext }: SynthesizeOptions = { voice: 'aura-2-thalia-en' },
): Promise<Buffer> {
  if (!VALID_VOICES.includes(voice)) {
    throw new Error(`voice must be one of: ${VALID_VOICES.join(', ')}`);
  }

  const params = new URLSearchParams({
    model: voice,
    encoding: 'linear16', // 16-bit PCM，配合 container=wav 才能拿到带 RIFF 头、能直接解析的 wav 文件
    container: 'wav',
    sample_rate: '24000', // 跟 domain/wav.js 的 ttsWavToDiscordPcm 假设的输入采样率对齐
  });

  const startedAt = Date.now();
  const audio = await postJsonForAudio(`/speak?${params}`, { text });
  const usageLog = buildTtsUsageFields({
    provider: 'deepgram',
    model: 'aura-2',
    voice,
    text,
    audio,
    elapsedMs: Date.now() - startedAt,
    logContext,
  });
  logger.info(usageLog, 'External API usage: TTS synthesis');
  await recordExternalApiUsage(usageLog);
  return audio;
}
