import { normalizeChineseText, buildTranslateCacheKey } from '../domain/translate-cache-key.js';
import { getCachedTranslation } from '../adapter/out/redis/translate-cache.js';

const NORMALIZERS: Partial<Record<string, (text: string) => string>> = {
  zh: normalizeChineseText,
};

export type TranslateCacheLookupResult =
  | { kind: 'not-applicable' }
  | { kind: 'empty-after-normalize'; normalizedText: string }
  | { kind: 'hit'; translatedText: string; cacheKey: string; normalizedText: string }
  | { kind: 'miss'; textForTranslation: string; cacheKey: string; normalizedText: string };

export interface TranslateCacheLookupParams {
  sourceLang: string | undefined;
  targetLang: string;
  gameId: string | undefined;
  transcriptText: string;
}

export async function lookupTranslationCache(params: TranslateCacheLookupParams): Promise<TranslateCacheLookupResult> {
  const { sourceLang, targetLang, gameId, transcriptText } = params;

  const normalize = sourceLang ? NORMALIZERS[sourceLang] : undefined;
  if (!normalize) return { kind: 'not-applicable' };

  const normalizedText = normalize(transcriptText);
  if (!normalizedText) return { kind: 'empty-after-normalize', normalizedText };

  const cacheKey = buildTranslateCacheKey({ gameId: gameId ?? '', srcLang: sourceLang!, tgtLang: targetLang, normalizedText });
  const cached = await getCachedTranslation(cacheKey);
  if (cached) return { kind: 'hit', translatedText: cached, cacheKey, normalizedText };

  return { kind: 'miss', textForTranslation: normalizedText, cacheKey, normalizedText };
}
