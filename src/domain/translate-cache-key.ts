import { createHash } from 'node:crypto';


const FILLER_PARTICLES = ['啊', '呀', '嘛', '呢', '哦', '噢', '诶', '哈', '嘞', '咯', '哇'];

const FULLWIDTH_TO_HALFWIDTH_PUNCTUATION: Record<string, string> = {
  '，': ',',
  '。': '.',
  '！': '!',
  '？': '?',
  '；': ';',
  '：': ':',
  '（': '(',
  '）': ')',
  '【': '[',
  '】': ']',
  '、': ',',
  '～': '~',
};

const FULLWIDTH_PUNCTUATION_PATTERN = new RegExp(
  `[${Object.keys(FULLWIDTH_TO_HALFWIDTH_PUNCTUATION).join('')}]`,
  'g',
);

function convertFullwidthPunctuation(text: string): string {
  return text.replace(FULLWIDTH_PUNCTUATION_PATTERN, (ch) => FULLWIDTH_TO_HALFWIDTH_PUNCTUATION[ch] ?? ch);
}

const FILLER_ALTERNATION = FILLER_PARTICLES.join('|');
const LEADING_FILLER_PATTERN = new RegExp(`^(?:${FILLER_ALTERNATION})+`, 'u');
const TRAILING_FILLER_PATTERN = new RegExp(`(?:${FILLER_ALTERNATION})+([!?.,;:~]*)$`, 'u');

export function normalizeChineseText(text: string): string {
  let result = text;

  result = convertFullwidthPunctuation(result);
  result = result.replace(/([!?.,;:~])\1+/g, '$1');

  result = result.replace(LEADING_FILLER_PATTERN, '');
  result = result.replace(TRAILING_FILLER_PATTERN, '$1');

  result = result.replace(/([一-鿿]+?)\1+/gu, '$1');

  result = result.replace(/[\s　]+/g, ' ').trim();

  return result;
}

export interface TranslateCacheKeyParams {
  gameId: string;
  srcLang: string;
  tgtLang: string;
  normalizedText: string;
}

export function buildTranslateCacheKey({ gameId, srcLang, tgtLang, normalizedText }: TranslateCacheKeyParams): string {
  const hash = createHash('sha256').update(`${gameId}:${srcLang}:${tgtLang}:${normalizedText}`).digest('hex');
  return `translate:${hash}`;
}
