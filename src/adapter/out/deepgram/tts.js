import { postJsonForAudio } from './client.js';

// 官方音色列表明确标了性别（不是我们猜的），来源：developers.deepgram.com/docs/tts-models
// 英文音色池最大（长期默认输出语言，多留几个方便区分不同说话人）；es/de/fr/ja 各自只接了
// 一男一女，够用即可，等 ports/tts.js 的 TTS_PROVIDER_BY_LANG 真涨到需要更多变体再补。
// nl/it 这两个 Aura-2 也支持，但 TTS_PROVIDER_BY_LANG 目前没路由到，先不接。
//
// 按"语言 -> 性别"两层分组，不是"性别 -> 全部语言混一起"——之前是后者（一个 female
// 数组把 25 个英文音色和 es/de/fr/ja 各一个音色全部塞在一起），assignVoice 按性别随机
// 挑的时候完全不知道要念哪种语言，随机抽中的音色语言跟目标语言对不上会导致播报异常
// （实测在 azure/tts.js 那边踩到了这个坑，这里是同一个模式，虽然因为英文池子最大、
// 被随机抽中非英语音色的概率低，没那么容易复现，但架构上是同一个 bug）。
export const VOICES_BY_LANG_AND_GENDER = {
  en: {
    female: [
      'aura-2-amalthea-en', 'aura-2-andromeda-en', 'aura-2-asteria-en', 'aura-2-athena-en',
      'aura-2-aurora-en', 'aura-2-callista-en', 'aura-2-cora-en', 'aura-2-cordelia-en',
      'aura-2-delia-en', 'aura-2-electra-en', 'aura-2-harmonia-en', 'aura-2-helena-en',
      'aura-2-hera-en', 'aura-2-iris-en', 'aura-2-janus-en', 'aura-2-juno-en',
      'aura-2-luna-en', 'aura-2-minerva-en', 'aura-2-ophelia-en', 'aura-2-pandora-en',
      'aura-2-phoebe-en', 'aura-2-selene-en', 'aura-2-thalia-en', 'aura-2-theia-en',
      'aura-2-vesta-en',
    ],
    male: [
      'aura-2-apollo-en', 'aura-2-arcas-en', 'aura-2-aries-en', 'aura-2-atlas-en',
      'aura-2-draco-en', 'aura-2-hermes-en', 'aura-2-hyperion-en', 'aura-2-jupiter-en',
      'aura-2-mars-en', 'aura-2-neptune-en', 'aura-2-odysseus-en', 'aura-2-orion-en',
      'aura-2-orpheus-en', 'aura-2-pluto-en', 'aura-2-saturn-en', 'aura-2-zeus-en',
    ],
  },
  es: { female: ['aura-2-celeste-es'], male: ['aura-2-nestor-es'] },
  de: { female: ['aura-2-viktoria-de'], male: ['aura-2-julius-de'] },
  fr: { female: ['aura-2-agathe-fr'], male: ['aura-2-hector-fr'] },
  ja: { female: ['aura-2-izanami-ja'], male: ['aura-2-fujin-ja'] },
};

// 提供给 synthesize() 内部校验用的扁平列表——校验"这是不是本供应商认识的音色"这件事
// 不需要知道语言，一个 provider 级别的合法音色集合就够了，跟 VOICES_BY_LANG_AND_GENDER
// 各自服务不同的目的（一个用于按语言分配音色，一个用于校验音色合法性）。
export const VALID_VOICES = Object.values(VOICES_BY_LANG_AND_GENDER).flatMap((byGender) => [
  ...(byGender.male ?? []),
  ...(byGender.female ?? []),
]);

export const TTS_SUPPORTED_LANGS = ['en', 'es', 'de', 'fr', 'ja'];

// text: 待合成文本。voice: 上面列表里的一个 model 名。
// 返回 wav Buffer，跟 groq/tts.js 的 synthesize() 返回形状一致——响应直接就是音频字节，
// 不像 Qwen 那样还要多一次下载。
export async function synthesize(text, { voice = 'aura-2-thalia-en' } = {}) {
  if (!VALID_VOICES.includes(voice)) {
    throw new Error(`voice 必须是以下之一：${VALID_VOICES.join(', ')}`);
  }

  const params = new URLSearchParams({
    model: voice,
    encoding: 'linear16', // 16-bit PCM，配合 container=wav 才能拿到带 RIFF 头、能直接解析的 wav 文件
    container: 'wav',
    sample_rate: '24000', // 跟 domain/wav.js 的 ttsWavToDiscordPcm 假设的输入采样率对齐
  });

  return postJsonForAudio(`/speak?${params}`, { text });
}
