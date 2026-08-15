import { synthesizeSsml } from './client.js';

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
export const VOICES_BY_GENDER = {
  male: ['zh-TW-YunJheNeural', 'ko-KR-InJoonNeural', 'pt-BR-AntonioNeural', 'ar-SA-HamedNeural'],
  female: [
    'zh-TW-HsiaoChenNeural',
    'zh-TW-HsiaoYuNeural',
    'ko-KR-SunHiNeural',
    'pt-BR-FranciscaNeural',
    'ar-SA-ZariyahNeural',
  ],
};

export const VALID_VOICES = [...VOICES_BY_GENDER.male, ...VOICES_BY_GENDER.female];

export const TTS_SUPPORTED_LANGS = ['zh', 'ko', 'pt', 'ar'];

// Azure 音色名字本身的前两段就是 locale（比如 "zh-TW-YunJheNeural" -> "zh-TW"），
// SSML 的 xml:lang 直接从音色名字拆出来用，不需要调用方另外传一份 locale——避免
// voice 和 lang 传得不一致导致 Azure 报错，或者音色跟语言对不上这种低级错误。
function localeFromVoiceName(voice) {
  const [lang, region] = voice.split('-');
  return `${lang}-${region}`;
}

// SSML 是 XML，文本里如果混进 &/</>/引号这些字符会把标签结构搞坏，合成前必须转义。
function escapeXml(text) {
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
export async function synthesize(text, { voice }) {
  if (!VALID_VOICES.includes(voice)) {
    throw new Error(`voice 必须是以下之一：${VALID_VOICES.join(', ')}`);
  }

  const locale = localeFromVoiceName(voice);
  const ssml = `<speak version='1.0' xml:lang='${locale}'><voice xml:lang='${locale}' name='${voice}'>${escapeXml(text)}</voice></speak>`;

  return synthesizeSsml(ssml);
}
