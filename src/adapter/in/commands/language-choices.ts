import type { AutocompleteInteraction } from 'discord.js';
import { TTS_PROVIDER_BY_LANG } from '../../../application/ports/tts.js';
import { SUPPORTED_SOURCE_LANGS } from '../../../application/ports/stt.js';
import { toBaseLang } from '../../../domain/language.js';

// 抽出来给 /lang 和 /config 共用——两个命令都要生成同样的 source/target 语言选项，
// 抽到一处维护，不让两边各自维护一份容易长出不一致（比如加了个新语言只改了一个命令）。

// Intl.DisplayNames 兜底：手写的 display name 表只覆盖了当前实际会用到的语言，新增
// 语言码忘了在表里补一条时，与其显示裸的语言码（用户看不懂 'bs' 是波斯尼亚语还是别的），
// 不如用 Node 内置的 ICU 数据生成一个还算过得去的英文名兜底。手写表依然是第一优先级——
// 像 zh-TW 需要显式标"Traditional"这种项目特定的措辞，Intl.DisplayNames 给不出来。
const langDisplayNames = new Intl.DisplayNames(['en'], { type: 'language' });
function fallbackDisplayName(code: string): string {
  try {
    return langDisplayNames.of(code) ?? code;
  } catch {
    return code;
  }
}

// --- source（SOURCE_LANG_CHOICES）：79 个具体 BCP-47 locale ---
// 2026-08-26：SUPPORTED_SOURCE_LANGS（见 ports/stt.js）从 9 个笼统基础码扩到 Deepgram
// 实际支持的全部 79 个 locale（照抄官方列表，换取更准的地区口音识别）。79 个远超
// Discord addChoices 单个 string option 25 个的硬上限，source 选项因此改用
// autocomplete（见下面 autocompleteLangOption），不能再像早期的 target 那样直接
// `.addChoices(...SOURCE_LANG_CHOICES)`——SOURCE_LANG_CHOICES 现在只是 autocomplete
// 用来过滤/展示的候选源数据，不直接喂给 addChoices。
const SOURCE_LANG_DISPLAY_NAMES: Record<string, string> = {
  'af-ZA': 'Afrikaans',
  'ar-AE': 'Arabic (UAE)',
  'ar-SA': 'Arabic (Saudi Arabia)',
  'ar-QA': 'Arabic (Qatar)',
  'ar-KW': 'Arabic (Kuwait)',
  'ar-SY': 'Arabic (Syria)',
  'ar-LB': 'Arabic (Lebanon)',
  'ar-PS': 'Arabic (Palestine)',
  'ar-JO': 'Arabic (Jordan)',
  'ar-EG': 'Arabic (Egypt)',
  'ar-SD': 'Arabic (Sudan)',
  'ar-TD': 'Arabic (Chad)',
  'ar-MA': 'Arabic (Morocco)',
  'ar-DZ': 'Arabic (Algeria)',
  'ar-TN': 'Arabic (Tunisia)',
  'ar-IQ': 'Arabic (Iraq)',
  'ar-IR': 'Arabic (Iran)',
  hy: 'Armenian',
  be: 'Belarusian',
  bn: 'Bengali',
  bs: 'Bosnian',
  bg: 'Bulgarian',
  ca: 'Catalan',
  'zh-HK': 'Chinese, Cantonese (Traditional)',
  'zh-CN': 'Chinese, Mandarin (Simplified)',
  'zh-TW': 'Chinese, Mandarin (Traditional)',
  hr: 'Croatian',
  cs: 'Czech',
  'da-DK': 'Danish',
  nl: 'Dutch',
  'en-US': 'English (US)',
  'en-AU': 'English (Australia)',
  'en-GB': 'English (UK)',
  'en-IN': 'English (India)',
  'en-NZ': 'English (New Zealand)',
  et: 'Estonian',
  fi: 'Finnish',
  'nl-BE': 'Flemish (Belgium)',
  'fr-CA': 'French (Canada)',
  'ka-GE': 'Georgian',
  de: 'German',
  'de-CH': 'German (Switzerland)',
  el: 'Greek',
  'gu-IN': 'Gujarati',
  he: 'Hebrew',
  hi: 'Hindi',
  hu: 'Hungarian',
  id: 'Indonesian',
  it: 'Italian',
  ja: 'Japanese',
  kn: 'Kannada',
  'ko-KR': 'Korean',
  lv: 'Latvian',
  lt: 'Lithuanian',
  mk: 'Macedonian',
  ms: 'Malay',
  mr: 'Marathi',
  ne: 'Nepali',
  no: 'Norwegian',
  fa: 'Persian',
  pl: 'Polish',
  'pt-BR': 'Portuguese (Brazil)',
  'pt-PT': 'Portuguese (Portugal)',
  'pa-IN': 'Punjabi',
  ro: 'Romanian',
  ru: 'Russian',
  sr: 'Serbian',
  sk: 'Slovak',
  sl: 'Slovenian',
  'es-419': 'Spanish (Latin America)',
  'sv-SE': 'Swedish',
  tl: 'Tagalog',
  ta: 'Tamil',
  te: 'Telugu',
  'th-TH': 'Thai',
  tr: 'Turkish',
  uk: 'Ukrainian',
  ur: 'Urdu',
  vi: 'Vietnamese',
};

// 2026-08-28：本地测试反馈两个问题，一起在这里解决——
// 1) 显示名太长："Chinese, Mandarin (Traditional) (zh-TW)" 这种全英文长名占满 Discord
//    autocomplete 下拉框的宽度（移动端更明显），改成只显示 locale 码本身（"zh-TW"），
//    用户认这个格式，一眼扫过去比一整行英文名好找。描述性英文名没有丢——挪进下面的
//    searchText，用户依然能打 "chinese"/"english" 这类词搜到对应项（选项框描述文字
//    "type to search, e.g. english" 承诺的还是这个行为），只是结果列表里不再显示它。
// 2) 常用语言"加载不出来"：79 个 locale 里排在最前面的是 af-ZA 和 17 个阿拉伯语变体，
//    英/中/日/韩这些最常用的语言在不打字的默认视图里完全看不到（Discord 一次最多回
//    25 条，还没轮到就被截掉了），看起来像没加载出来。这里显式把项目实际主打的 9 种
//    语言（跟 CLAUDE.md「供应商可切换」一节的 TTS 九语言、以及本文件里 zh 用繁体/ar
//    用沙特/pt 用巴西口音的既定选型对齐）排到最前面，其余 locale 仍按原顺序跟在后面，
//    不打字时至少这几个常用语言在首屏可见。
const PRIORITY_LANG_CODES = ['zh-TW', 'en-US', 'ko-KR', 'ar-SA', 'fr-CA', 'ja', 'de', 'es-419', 'pt-BR'];

interface LangChoice {
  name: string;
  value: string;
  // 只用来匹配用户输入，不会出现在发给 Discord 的 respond() 里（见 filterChoices 最后
  // 一步的 map，会把这个字段剥掉）。
  searchText: string;
}

// 从 SUPPORTED_SOURCE_LANGS 生成——手动能选的语言范围就是项目实际准备好处理的源语言
// 范围，两处引用同一个数组，不重复维护。按 PRIORITY_LANG_CODES 排到最前面、其余保持
// 原有顺序跟在后面（sort 是 stable sort，"其余顺序不变"这个前提在 Node 里是有保证的）。
function bySourceLangPriority(a: { value: string }, b: { value: string }): number {
  const aIdx = PRIORITY_LANG_CODES.indexOf(a.value);
  const bIdx = PRIORITY_LANG_CODES.indexOf(b.value);
  if (aIdx === -1 && bIdx === -1) return 0;
  if (aIdx === -1) return 1;
  if (bIdx === -1) return -1;
  return aIdx - bIdx;
}

export const SOURCE_LANG_CHOICES: LangChoice[] = SUPPORTED_SOURCE_LANGS.map((lang) => {
  const displayName = SOURCE_LANG_DISPLAY_NAMES[lang] ?? fallbackDisplayName(lang);
  return {
    name: lang,
    value: lang,
    searchText: `${displayName} ${lang}`.toLowerCase(),
  };
}).sort(bySourceLangPriority);

// --- target（TARGET_LANG_CHOICES）---
// 2026-08-26 之前：target 选项直接就是 TTS_PROVIDER_BY_LANG 的 key，笼统的 ISO-639-1
// 基础码（'en'/'zh'/...），不区分地区。
//
// 2026-08-26 起：跟 source 统一成具体 locale（比如 'en-IN'/'en-US' 而不是笼统的
// 'en'）——不是因为 TTS 供应商路由需要地区颗粒度（TTS_PROVIDER_BY_LANG/音色池依然只按
// 基础语言码分组，没有哪个供应商是"只覆盖 en-IN 不覆盖 en-US"这种颗粒度，见
// ports/tts.js），而是因为翻译这一步（LLM prompt，见 translation-prompt.js）直接吃
// locale 能拿到更准的地区措辞（比如翻成 en-US 得到 "color"、翻成 en-GB 得到
// "colour"）——跟 source locale 提升 STT 识别准确度是类似的理由，只是发生在链路的
// 另一端。session.js 的 setTargetLang 存的是这个 locale 原值，但传给
// resolveTtsProvider/assignVoice 之前会先用 toBaseLang() 还原成基础码，见 session.js/
// pipeline.js 的注释。
//
// 具体做法：复用 SOURCE_LANG_CHOICES 现成的 79 个 locale，只保留 toBaseLang() 之后落在
// TTS_PROVIDER_BY_LANG 里的那些——这样"这个 locale 能不能选作 target"永远跟"它的基础
// 语言有没有 TTS 供应商"这件事同步，不用手动维护第二份 locale 列表。反过来，某个基础
// 语言在 source 79 个 locale 里如果只有裸码没有地区变体（比如 'ja'、'it'），target 这边
// 就只会出现这一个裸码选项，不会凭空造出不存在的地区变体。
export const TARGET_LANG_CHOICES = SOURCE_LANG_CHOICES.filter((choice) => {
  const base = toBaseLang(choice.value);
  return base !== undefined && TTS_PROVIDER_BY_LANG[base] !== undefined;
});

// execute() 服务端校验用的合法 target 取值集合（locale 级）——见下面 autocompleteLangOption
// 注释，autocomplete 不像 addChoices，不能假设用户最终提交的值一定来自候选列表。
export const SUPPORTED_TARGET_LOCALES = TARGET_LANG_CHOICES.map((choice) => choice.value);

// Discord autocomplete 单次响应硬上限：超过 25 条会被拒绝。
const AUTOCOMPLETE_LIMIT = 25;

function filterChoices(choices: LangChoice[], focused: string): { name: string; value: string }[] {
  const matches = focused ? choices.filter((choice) => choice.searchText.includes(focused)) : choices;
  // searchText 只是本地匹配用的，不发给 Discord——respond() 只接受 name/value，多余字段
  // 不一定会被忽略，显式 map 掉更保险。
  return matches.slice(0, AUTOCOMPLETE_LIMIT).map(({ name, value }) => ({ name, value }));
}

// /lang、/config 的 source 和 target 选项现在都用 autocomplete（source 79 个 locale、
// target 78 个 locale，都超过了 addChoices 25 个上限），共用这一个 handler——按
// interaction.options.getFocused(true).name 判断用户当前在哪个选项框里打字，决定过滤
// 哪张候选列表，而不是像早期那样一个命令对应一个专门的 source-only handler。
// 各自在 data 里 setAutocomplete(true)，index.js 按 interaction.commandName 分发过来。
//
// 注意：autocomplete 选项不像 addChoices，Discord 不会在服务端强制用户最终提交的值
// 必须来自候选列表（用户可以打完字直接回车提交自由文本）。调用方（lang.js/config.js
// 的 execute）必须自己再校验一遍 source/target 是否分别在 SUPPORTED_SOURCE_LANGS /
// SUPPORTED_TARGET_LOCALES 里，不能假设 autocomplete 已经把关卡住了。
export async function autocompleteLangOption(interaction: AutocompleteInteraction): Promise<void> {
  const { name, value } = interaction.options.getFocused(true);
  const focused = value.trim().toLowerCase();
  const choices = name === 'target' ? TARGET_LANG_CHOICES : SOURCE_LANG_CHOICES;
  await interaction.respond(filterChoices(choices, focused));
}
