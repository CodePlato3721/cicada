import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupTranslationCache } from '../../../dist/application/translate-cache-lookup.js';
import { ensureRedisReady, redisClient } from '../../../dist/adapter/out/redis/client.js';
import { buildTranslateCacheKey } from '../../../dist/domain/translate-cache-key.js';

before(async () => {
  await ensureRedisReady();
});

after(() => {
  redisClient.disconnect();
});

test('lookupTranslationCache returns not-applicable for non-Chinese or missing source language', async () => {
  const en = await lookupTranslationCache({ sourceLang: 'en', targetLang: 'zh', gameId: 'whiteout', transcriptText: 'flank now' });
  assert.deepEqual(en, { kind: 'not-applicable' });

  const undetected = await lookupTranslationCache({ sourceLang: undefined, targetLang: 'zh', gameId: 'whiteout', transcriptText: 'hi' });
  assert.deepEqual(undetected, { kind: 'not-applicable' });
});

test('lookupTranslationCache returns empty-after-normalize for pure Chinese filler words', async () => {
  const result = await lookupTranslationCache({ sourceLang: 'zh', targetLang: 'en', gameId: 'whiteout', transcriptText: '啊啊啊' });
  assert.deepEqual(result, { kind: 'empty-after-normalize', normalizedText: '' });
});

test('lookupTranslationCache returns miss with normalized text and cacheKey when Redis has no entry', async () => {
  const normalizedText = '我要去打野';
  const cacheKey = buildTranslateCacheKey({ gameId: 'whiteout', srcLang: 'zh', tgtLang: 'en', normalizedText });
  await redisClient.del(cacheKey);

  const result = await lookupTranslationCache({ sourceLang: 'zh', targetLang: 'en', gameId: 'whiteout', transcriptText: '我我我要去打野啊' });

  assert.equal(result.kind, 'miss');
  assert.equal(result.textForTranslation, normalizedText);
  assert.equal(result.normalizedText, normalizedText);
  assert.equal(result.cacheKey, cacheKey);
});

test('lookupTranslationCache uses an empty gameId slot when gameId is missing', async () => {
  const normalizedText = '你好';
  const cacheKey = buildTranslateCacheKey({ gameId: '', srcLang: 'zh', tgtLang: 'en', normalizedText });
  await redisClient.del(cacheKey);

  const result = await lookupTranslationCache({ sourceLang: 'zh', targetLang: 'en', gameId: undefined, transcriptText: normalizedText });

  assert.equal(result.kind, 'miss');
  assert.equal(result.normalizedText, normalizedText);
  assert.equal(result.cacheKey, cacheKey);
});
