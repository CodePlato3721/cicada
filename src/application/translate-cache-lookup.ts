import { normalizeChineseText, buildTranslateCacheKey } from '../domain/translate-cache-key.js';
import { getCachedTranslation } from '../adapter/out/redis/translate-cache.js';

// 每种接入了翻译缓存的源语言对应一张表：语言代码 → 规范化函数。目前只有中文
// （见 DESIGN.md「Scope」，非中文源语言查表查不到，直接判定 'not-applicable'）。
// 以后要给别的源语言接入缓存，只需要在这张表里加一条对应的规范化函数——pipeline.ts
// 不知道、也不需要知道这里支持哪些语言，它只认 lookupTranslationCache 返回的四种结果。
const NORMALIZERS: Partial<Record<string, (text: string) => string>> = {
  zh: normalizeChineseText,
};

export type TranslateCacheLookupResult =
  // 这个源语言没有接入缓存（目前是除中文外的所有语言）——调用方应该完全当缓存层
  // 不存在，用原始转写文本走原有流程，不查缓存也不写缓存。
  | { kind: 'not-applicable' }
  // 规范化之后是空字符串（纯语气词/噪音）——调用方应该跳过这句话的翻译/播放，
  // 不产出任何输出，也不写缓存。
  | { kind: 'empty-after-normalize'; normalizedText: string }
  // 命中缓存，直接把译文给调用方，不用再走术语检测/LLM 翻译。
  | { kind: 'hit'; translatedText: string; cacheKey: string; normalizedText: string }
  // 没命中（或 Redis 不可用，见 adapter/out/redis/translate-cache.js 的降级逻辑）——
  // 调用方应该用 textForTranslation（规范化后的文本，不是原始转写）继续走术语检测/
  // LLM 翻译，翻译完之后用 cacheKey 写回缓存。
  | { kind: 'miss'; textForTranslation: string; cacheKey: string; normalizedText: string };

export interface TranslateCacheLookupParams {
  sourceLang: string | undefined;
  targetLang: string;
  gameId: string | undefined;
  transcriptText: string;
}

// 翻译缓存的查询入口：判断这个源语言是否接入了缓存、规范化文本、算 key、查 Redis，
// 把结果归成上面四种之一交给调用方。调用方（pipeline.js）不需要关心"目前只支持中文"
// 这件事，也不需要自己调用规范化函数或拼 key——这些都是这个函数的内部细节。
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
