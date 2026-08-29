import type { AutocompleteInteraction } from 'discord.js';
import { SUPPORTED_TARGET_LANGS } from '../../../application/ports/tts.js';
import { SUPPORTED_SOURCE_LANGS } from '../../../application/ports/stt.js';


const langDisplayNames = new Intl.DisplayNames(['en'], { type: 'language' });
function fallbackDisplayName(code: string): string {
  try {
    return langDisplayNames.of(code) ?? code;
  } catch {
    return code;
  }
}

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

const PRIORITY_LANG_CODES = ['zh-TW', 'zh', 'en-US', 'en', 'ko-KR', 'ko', 'ar-SA', 'ar', 'fr-CA', 'fr', 'ja', 'de', 'es-419', 'es', 'pt-BR', 'pt'];

interface LangChoice {
  name: string;
  value: string;
  searchText: string;
}

function byLangPriority(a: { value: string }, b: { value: string }): number {
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
    name: `${displayName} (${lang})`,
    value: lang,
    searchText: `${displayName} ${lang}`.toLowerCase(),
  };
}).sort(byLangPriority);


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

export const SUPPORTED_TARGET_VALUES = TARGET_LANG_CHOICES.map((choice) => choice.value);

const AUTOCOMPLETE_LIMIT = 25;

function filterChoices(choices: LangChoice[], focused: string): { name: string; value: string }[] {
  const matches = focused ? choices.filter((choice) => choice.searchText.includes(focused)) : choices;
  return matches.slice(0, AUTOCOMPLETE_LIMIT).map(({ name, value }) => ({ name, value }));
}

export async function autocompleteLangOption(interaction: AutocompleteInteraction): Promise<void> {
  const { name, value } = interaction.options.getFocused(true);
  const focused = value.trim().toLowerCase();
  const choices = name === 'target' ? TARGET_LANG_CHOICES : SOURCE_LANG_CHOICES;
  await interaction.respond(filterChoices(choices, focused));
}
