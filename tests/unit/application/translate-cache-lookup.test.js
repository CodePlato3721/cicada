// lookupTranslationCache 的语言路由逻辑（哪些源语言接入缓存、怎么规范化）是它的内部
// 细节，这里只断言外部能看到的四种结果。
//
// 强制在“缓存层禁用”的确定性环境下跑这份测试——不依赖开发机 .env 里有没有配置真实的
// REDIS_URL。踩过的真实坑：本地 .env 一旦配了 REDIS_URL，import config.js 时 dotenv
// 会读到它，这份测试就会打一个真的 Redis 连接——一是 'miss' 断言不再是确定性的（真
// 连上的话，前一次跑测试写进去的 key 这次可能变成 'hit'，取决于 TTL 有没有过期，
// 断言会跟着环境漂移）；二是这个 ioredis 连接不会被这份测试主动关闭，`node --test`
// 会因为事件循环里还挂着这个连接一直不退出，整个 npm run test:unit 卡死不返回
// （实测复现过：加了 REDIS_URL 之后再跑测试，进程真的会挂住）。
// dotenv 不会覆盖 process.env 里已经存在的变量，所以在这里显式赋值成空字符串——
// 无论 .env 里写了什么，config.js 读到的 REDIS_URL 都是空字符串（falsy，视为未配置），
// adapter/out/redis/translate-cache.js 的 getCachedTranslation 因此恒定返回 null，
// 缓存层禁用，'miss' 分支可以直接用真实模块断言，不用 mock；'hit' 分支依赖一个真的
// 会返回值的 Redis，不在这份单测覆盖范围内，见 CCD-3 CR 的手动验证步骤。
//
// 注意：ES module 的 `import` 声明会被提升到整个文件最前面执行，不管写在源码里的
// 哪个位置——如果这里用静态 `import { lookupTranslationCache } from '...'`，上面这行
// `process.env.REDIS_URL = ''` 会在 import 触发的 config.js/dotenv 求值之后才执行，
// 完全不起作用（第一次这么写就是这个坑，测试照样连真 Redis）。所以 lookupTranslationCache
// 改用动态 `import()`，它是一条普通语句，会按源码顺序在这行赋值之后才执行。
// buildTranslateCacheKey 不需要这样处理——domain/translate-cache-key.js 是纯函数，
// 不引用 config.js/Redis，静态 import 没有这个问题。
process.env.REDIS_URL = '';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTranslateCacheKey } from '../../../dist/domain/translate-cache-key.js';

const { lookupTranslationCache } = await import('../../../dist/application/translate-cache-lookup.js');

test('lookupTranslationCache：非中文源语言（含 undefined）返回 not-applicable，不规范化不查缓存', async () => {
  const en = await lookupTranslationCache({ sourceLang: 'en', targetLang: 'zh', gameId: 'whiteout', transcriptText: 'flank now' });
  assert.deepEqual(en, { kind: 'not-applicable' });

  const undetected = await lookupTranslationCache({ sourceLang: undefined, targetLang: 'zh', gameId: 'whiteout', transcriptText: 'hi' });
  assert.deepEqual(undetected, { kind: 'not-applicable' });
});

test('lookupTranslationCache：中文规范化后是空字符串（纯语气词）返回 empty-after-normalize', async () => {
  const result = await lookupTranslationCache({ sourceLang: 'zh', targetLang: 'en', gameId: 'whiteout', transcriptText: '啊啊啊' });
  assert.deepEqual(result, { kind: 'empty-after-normalize', normalizedText: '' });
});

test('lookupTranslationCache：中文有实际内容、缓存未命中（测试环境没配 REDIS_URL）返回 miss，带规范化后文本和对应 cacheKey', async () => {
  const result = await lookupTranslationCache({ sourceLang: 'zh', targetLang: 'en', gameId: 'whiteout', transcriptText: '我我我要去打野啊' });

  assert.equal(result.kind, 'miss');
  assert.equal(result.textForTranslation, '我要去打野');
  assert.equal(result.normalizedText, '我要去打野');
  assert.equal(
    result.cacheKey,
    buildTranslateCacheKey({ gameId: 'whiteout', srcLang: 'zh', tgtLang: 'en', normalizedText: '我要去打野' }),
  );
});

test('lookupTranslationCache：gameId 缺失时用空字符串占位，跟直接调用 buildTranslateCacheKey 结果一致', async () => {
  const result = await lookupTranslationCache({ sourceLang: 'zh', targetLang: 'en', gameId: undefined, transcriptText: '你好' });

  assert.equal(result.kind, 'miss');
  assert.equal(result.normalizedText, '你好');
  assert.equal(
    result.cacheKey,
    buildTranslateCacheKey({ gameId: '', srcLang: 'zh', tgtLang: 'en', normalizedText: '你好' }),
  );
});
