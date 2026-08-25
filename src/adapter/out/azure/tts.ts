import type { SynthesizeOptions, VoicesByGender } from '../../../application/ports/tts.js';
import { synthesizeSsml } from './client.js';
import { createLogger } from '../logger.js';
import { buildTtsUsageFields } from '../usage-log.js';
import { recordExternalApiUsage } from '../../../application/billing/billing-service.js';
import voiceCatalog from '../../../config/tts-voices-azure.json' with { type: 'json' };

const logger = createLogger('azure/tts');

// Azure Speech 支持的语言范围比 Deepgram Aura-2 广得多，这里只列出 ports/tts.js 的
// TTS_PROVIDER_BY_LANG 实际路由过来的语言（zh/ko/pt/ar）对应的音色，不是 Azure 全部
// 音色目录——以后 TTS_PROVIDER_BY_LANG 加了新语言指向 azure，再来这里补对应的音色。
// 全部名字已核实存在于 Azure 官方语音列表（learn.microsoft.com 的 language-support
// 文档，tts 标签页）。
//
// - 中文用繁体 zh-TW，不是简体 zh-CN：跟 deepgram/stt.js 里 zh→zh-TW 的映射同一个理由——
//   项目目标用户群排除中国大陆、以繁体中文使用者为主（台湾/香港/海外华人）。
// - 阿拉伯语用沙特阿拉伯 ar-SA：Azure 的音色都是具体地区变体，没有跟 Deepgram STT 那边
//   裸的 'ar' 代码对应的"通用阿拉伯语"选项，ar-SA 对应的现代标准阿拉伯语是最接近
//   "通用"的选择。
// - 葡萄牙语用巴西口音 pt-BR，不是葡萄牙本土 pt-PT：全球使用人口巴西远多于葡萄牙。
//
// 按"语言 -> 性别"两层分组，不是"性别 -> 全部语言混一起"——之前是后者（一个 male 数组
// 塞了 zh/ko/pt/ar 四种语言的音色），assignVoice 按性别随机挑的时候完全不知道要念哪种
// 语言，实测出现过目标语言是中文、却随机抽中葡萄牙语音色去念中文文本，Azure 只能返回
// 一份近乎空的音频（44 字节，没有实际语音内容），下游 WAV 解析直接报错。语言必须是
// 分组的第一层，同一门语言内部才按性别再分一层。
// tts-voices-azure.json 现在直接就是 Record<语言, VoicesByGender> 这个形状（没有 locale
// 字段、也没有外层 "azure" 包裹键）——locale 会从音色名字本身派生（见下面
// localeFromVoiceName），单独存一份 locale 字段只是重复数据，容易跟音色名字本身的
// 地区变体改串了却没人发现，索性去掉。这跟 deepgram/tts.ts 的 tts-voices-deepgram.json
// 是同一个结构，两个供应商都能直接把 JSON import 当 VOICES_BY_LANG_AND_GENDER 用，
// 不需要各自写一遍转换逻辑。
export const VOICES_BY_LANG_AND_GENDER: Record<string, VoicesByGender> = voiceCatalog;

// 提供给 synthesize() 内部校验用的扁平列表——校验"这是不是本供应商认识的音色"这件事
// 不需要知道语言，一个 provider 级别的合法音色集合就够了，跟 VOICES_BY_LANG_AND_GENDER
// 各自服务不同的目的（一个用于按语言分配音色，一个用于校验音色合法性）。
export const VALID_VOICES: string[] = Object.values(VOICES_BY_LANG_AND_GENDER).flatMap((byGender) => [
  ...(byGender.male ?? []),
  ...(byGender.female ?? []),
]);

export const TTS_SUPPORTED_LANGS = ['en', 'fr', 'ja', 'de', 'es', 'zh', 'ko', 'pt', 'ar'];

// Azure 音色名字本身的前两段就是 locale（比如 "zh-TW-YunJheNeural" -> "zh-TW"），
// SSML 的 xml:lang 直接从音色名字拆出来用，不需要调用方另外传一份 locale——避免
// voice 和 lang 传得不一致导致 Azure 报错，或者音色跟语言对不上这种低级错误。
function localeFromVoiceName(voice: string): string {
  const [lang, region] = voice.split('-');
  return `${lang}-${region}`;
}

// SSML 是 XML，文本里如果混进 &/</>/引号这些字符会把标签结构搞坏，合成前必须转义。
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// text: 待合成文本。voice: 上面列表里的一个音色名。
// 这个签名里没有 targetLang 参数——不像 deepgram/groq 那两个 adapter，Azure 这边语言
// 完全由 voice 名字决定，不需要额外传 targetLang；ports/tts.js 统一调用时无论传不传
// 都不会出错（这个函数直接忽略多余的参数）。
export async function synthesize(text: string, { voice, logContext }: SynthesizeOptions): Promise<Buffer> {
  if (!VALID_VOICES.includes(voice)) {
    throw new Error(`voice must be one of: ${VALID_VOICES.join(', ')}`);
  }

  const locale = localeFromVoiceName(voice);
  const ssml = `<speak version='1.0' xml:lang='${locale}'><voice xml:lang='${locale}' name='${voice}'>${escapeXml(text)}</voice></speak>`;

  const startedAt = Date.now();
  const audio = await synthesizeSsml(ssml);
  const usageLog = buildTtsUsageFields({
    provider: 'azure',
    model: 'neural',
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
