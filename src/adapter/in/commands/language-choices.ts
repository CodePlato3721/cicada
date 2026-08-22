import { TTS_PROVIDER_BY_LANG } from '../../../application/ports/tts.js';
import { SUPPORTED_SOURCE_LANGS } from '../../../application/ports/stt.js';

// 抽出来给 /lang 和 /config 共用——两个命令都要生成同样的 source/target 语言选项，
// 抽到一处维护，不让两边各自维护一份容易长出不一致（比如加了个新语言只改了一个命令）。
//
// 这里统一用 'zh' 这个 ISO 码而不区分简繁——语音场景不需要在选语言的时候纠结简体/繁体，
// 后端术语库内部用繁体匹配（见 terminology.js 的 opencc 正规化）跟这里选什么字面值无关，
// 用户不用关心这层。
//
// source 和 target 的可选语言列表不对称，是 STT/TTS 两个环节依赖的能力不一样导致的：
// source 只依赖 STT（Deepgram Nova-3 语言覆盖很广，这里先按项目实际用得上的挑了四个）；
// target 同时依赖 LLM 翻译（几乎任何语言都行）和 TTS 播报（决定性瓶颈）——现在 TTS 是
// 多供应商路由（见 ports/tts.js 的 TTS_PROVIDER_BY_LANG：en/fr/ja/de/es 走 Deepgram，
// zh/ko/pt/ar 走 Azure），target 选项直接从这张表的 key 生成，不再是之前只有 Deepgram
// 单一供应商时被迫限制成"只有 zh/en 两个能出声音"那个阶段。这里显式列出人类可读的语言名
// （用来生成 addChoices 的 name），跟 TTS_PROVIDER_BY_LANG 是同一份语言范围，只是那边
// 关心的是"该用哪个供应商"，这边关心的是"选项菜单里叫什么名字"。
const LANG_DISPLAY_NAMES: Record<string, string> = {
  zh: 'Chinese (zh)',
  en: 'English (en)',
  ko: 'Korean (ko)',
  ar: 'Arabic (ar)',
  fr: 'French (fr)',
  ja: 'Japanese (ja)',
  de: 'German (de)',
  es: 'Spanish (es)',
  pt: 'Portuguese (pt)',
};

// 从 SUPPORTED_SOURCE_LANGS 生成——手动能选的语言范围就是项目实际准备好处理的源语言
// 范围，两处引用同一个数组，不重复维护。
export const SOURCE_LANG_CHOICES = SUPPORTED_SOURCE_LANGS.map((lang) => ({
  name: LANG_DISPLAY_NAMES[lang] ?? lang,
  value: lang,
}));

// 从 TTS_PROVIDER_BY_LANG 的 key 生成，保证 target 选项永远跟"这个语言实际有没有 TTS
// 供应商能播"这件事同步——以后加/删一个 TTS_PROVIDER_BY_LANG 条目，这里的选项自动跟着变，
// 不用两个地方分别改、改漏了导致选项和实际能力对不上。
export const TARGET_LANG_CHOICES = Object.keys(TTS_PROVIDER_BY_LANG).map((lang) => ({
  name: LANG_DISPLAY_NAMES[lang] ?? lang,
  value: lang,
}));
