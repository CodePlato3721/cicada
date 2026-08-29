import type { AutocompleteInteraction } from 'discord.js';
import { SUPPORTED_TARGET_LANGS } from '../../../application/ports/tts.js';
import { SUPPORTED_SOURCE_LANGS } from '../../../application/ports/stt.js';

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
  'ar-AE': 'UAE',
  'ar-SA': 'Saudi Arabia',
  'ar-QA': 'Qatar',
  'ar-KW': 'Kuwait',
  'ar-SY': 'Syria',
  'ar-LB': 'Lebanon',
  'ar-PS': 'Palestine',
  'ar-JO': 'Jordan',
  'ar-EG': 'Egypt',
  'ar-SD': 'Sudan',
  'ar-TD': 'Chad',
  'ar-MA': 'Morocco',
  'ar-DZ': 'Algeria',
  'ar-TN': 'Tunisia',
  'ar-IQ': 'Iraq',
  'ar-IR': 'Iran',
  hy: 'Armenian',
  be: 'Belarusian',
  bn: 'Bengali',
  bs: 'Bosnian',
  bg: 'Bulgarian',
  ca: 'Catalan',
  'zh-HK': 'Traditional Cantonese',
  'zh-CN': 'Simplified',
  'zh-TW': 'Traditional',
  hr: 'Croatian',
  cs: 'Czech',
  'da-DK': 'Danish',
  nl: 'Dutch',
  'en-US': 'US',
  'en-AU': 'Australia',
  'en-GB': 'UK',
  'en-IN': 'India',
  'en-NZ': 'New Zealand',
  et: 'Estonian',
  fi: 'Finnish',
  'nl-BE': 'Belgium',
  'fr-CA': 'Canada',
  'ka-GE': 'Georgian',
  de: 'German',
  'de-CH': 'Switzerland',
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
  'pt-BR': 'Brazil',
  'pt-PT': 'Portugal',
  'pa-IN': 'Punjabi',
  ro: 'Romanian',
  ru: 'Russian',
  sr: 'Serbian',
  sk: 'Slovak',
  sl: 'Slovenian',
  'es-419': 'Latin America',
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
// 1) 完整显示名太长："Chinese, Mandarin (Traditional) (zh-TW)" 这种全英文长名占满 Discord
//    autocomplete 下拉框的宽度（移动端更明显）。上面的显示名表直接维护短名，所以结果
//    列表显示 "Traditional (zh-TW)" 这种短名称 + code。
// 2) 常用语言"加载不出来"：79 个 locale 里排在最前面的是 af-ZA 和 17 个阿拉伯语变体，
//    英/中/日/韩这些最常用的语言在不打字的默认视图里完全看不到（Discord 一次最多回
//    25 条，还没轮到就被截掉了），看起来像没加载出来。这里显式把项目实际主打的语言
//    排到最前面，其余语言仍按原顺序跟在后面，不打字时至少这几个常用语言在首屏可见。
//    source 用具体 locale，target 用基础语言码，所以同一组优先级同时列出两种形态。
const PRIORITY_LANG_CODES = ['zh-TW', 'zh', 'en-US', 'en', 'ko-KR', 'ko', 'ar-SA', 'ar', 'fr-CA', 'fr', 'ja', 'de', 'es-419', 'es', 'pt-BR', 'pt'];

interface LangChoice {
  name: string;
  value: string;
  // 只用来匹配用户输入，不会出现在发给 Discord 的 respond() 里（见 filterChoices 最后
  // 一步的 map，会把这个字段剥掉）。
  searchText: string;
}

// 通用的"按 PRIORITY_LANG_CODES 排到最前面、其余保持原有顺序跟在后面"排序器，
// source/target 两份列表各自调用一次（sort 是 stable sort，"其余顺序不变"这个前提在
// Node 里是有保证的）。2026-08-28 从只服务 source 的 bySourceLangPriority 改成通用函数
// ——source/target 各自维护自己的候选语言集合（见下面 target 那段注释），不该共用同一个
// 硬编码的 comparator 名字暗示"这俩是一回事"。
function byLangPriority(a: { value: string }, b: { value: string }): number {
  const aIdx = PRIORITY_LANG_CODES.indexOf(a.value);
  const bIdx = PRIORITY_LANG_CODES.indexOf(b.value);
  if (aIdx === -1 && bIdx === -1) return 0;
  if (aIdx === -1) return 1;
  if (bIdx === -1) return -1;
  return aIdx - bIdx;
}

// 从 SUPPORTED_SOURCE_LANGS 生成——手动能选的语言范围就是项目实际准备好处理的源语言
// 范围，两处引用同一个数组，不重复维护。
export const SOURCE_LANG_CHOICES: LangChoice[] = SUPPORTED_SOURCE_LANGS.map((lang) => {
  const displayName = SOURCE_LANG_DISPLAY_NAMES[lang] ?? fallbackDisplayName(lang);
  return {
    name: `${displayName} (${lang})`,
    value: lang,
    searchText: `${displayName} ${lang}`.toLowerCase(),
  };
}).sort(byLangPriority);

// --- target（TARGET_LANG_CHOICES）---
// 2026-08-28：target 不复用 SOURCE_LANG_CHOICES。之前的做法是过滤 SOURCE_LANG_CHOICES
// （79 个 STT locale）、只保留 toBaseLang() 落在 TTS_PROVIDER_BY_LANG 里的那些——这样
// target 能选到的具体 locale 变成"STT 支持哪个地区变体"决定的，跟 STT 的候选列表耦合在
// 一起：source 加/删一个 locale，target 的选项会跟着变，即使那个 locale 对应的基础语言
// 在 TTS 那边完全没变化；反过来 TTS 新支持一个基础语言，但 source 79 个 locale 里如果连
// 一个对应的 locale 都没有，target 就没法选它，即便 TTS 供应商已经能出声音。这个耦合没
// 有实际必要——source/target 依赖的能力完全不同（STT vs. LLM 翻译+TTS），不该共用同一份
// 底层数据。现在 target 直接从 SUPPORTED_TARGET_LANGS（即 TTS_PROVIDER_BY_LANG 的
// key，TTS 供应商实际支持的基础语言，见 ports/tts.js）生成。TTS 不需要地区颗粒度，
// 对外保存和校验的 target 值也保持基础语言码；只有翻译 prompt 对 zh 做繁中偏好处理，
// 见 domain/translation-prompt.js。

const TARGET_LANG_DISPLAY_NAMES: Record<string, string> = {
  zh: 'Traditional',
  en: 'English',
  ko: 'Korean',
  ar: 'Arabic',
  fr: 'French',
  es: 'Spanish',
  pt: 'Portuguese',
};

export const TARGET_LANG_CHOICES: LangChoice[] = SUPPORTED_TARGET_LANGS.map((base) => {
  const displayName = TARGET_LANG_DISPLAY_NAMES[base] ?? fallbackDisplayName(base);
  return {
    name: `${displayName} (${base})`,
    value: base,
    searchText: `${displayName} ${base}`.toLowerCase(),
  };
}).sort(byLangPriority);

// execute() 服务端校验用的合法 target 取值集合——见下面 autocompleteLangOption 注释，
// autocomplete 不像 addChoices，不能假设用户最终提交的值一定来自候选列表。
export const SUPPORTED_TARGET_VALUES = TARGET_LANG_CHOICES.map((choice) => choice.value);

// Discord autocomplete 单次响应硬上限：超过 25 条会被拒绝。
const AUTOCOMPLETE_LIMIT = 25;

function filterChoices(choices: LangChoice[], focused: string): { name: string; value: string }[] {
  const matches = focused ? choices.filter((choice) => choice.searchText.includes(focused)) : choices;
  // searchText 只是本地匹配用的，不发给 Discord——respond() 只接受 name/value，多余字段
  // 不一定会被忽略，显式 map 掉更保险。
  return matches.slice(0, AUTOCOMPLETE_LIMIT).map(({ name, value }) => ({ name, value }));
}

// /lang、/config 的 source 和 target 选项现在都用 autocomplete（source 79 个 locale、
// target 54 个基础语言，都超过了 addChoices 25 个上限），共用这一个 handler——按
// interaction.options.getFocused(true).name 判断用户当前在哪个选项框里打字，决定过滤
// 哪张候选列表，而不是像早期那样一个命令对应一个专门的 source-only handler。
// 各自在 data 里 setAutocomplete(true)，index.js 按 interaction.commandName 分发过来。
//
// 注意：autocomplete 选项不像 addChoices，Discord 不会在服务端强制用户最终提交的值
// 必须来自候选列表（用户可以打完字直接回车提交自由文本）。调用方（lang.js/config.js
// 的 execute）必须自己再校验一遍 source/target 是否分别在 SUPPORTED_SOURCE_LANGS /
// SUPPORTED_TARGET_VALUES 里，不能假设 autocomplete 已经把关卡住了。
export async function autocompleteLangOption(interaction: AutocompleteInteraction): Promise<void> {
  const { name, value } = interaction.options.getFocused(true);
  const focused = value.trim().toLowerCase();
  const choices = name === 'target' ? TARGET_LANG_CHOICES : SOURCE_LANG_CHOICES;
  await interaction.respond(filterChoices(choices, focused));
}
