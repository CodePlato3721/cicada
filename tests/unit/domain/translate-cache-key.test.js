// domain/translate-cache-key.js 的 normalizeChineseText/buildTranslateCacheKey 都是纯函数
// （不涉及网络/Redis，具体的 Redis 读写在 adapter/out/redis/translate-cache.js），
// 按 DESIGN.md「Normalization」列的固定顺序（标点 → 语气词 → 重复压缩 → 空白）逐条断言。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChineseText, buildTranslateCacheKey } from '../../../dist/domain/translate-cache-key.js';

test('normalizeChineseText：全角标点转半角，连续重复标点合并为一次', () => {
  assert.equal(normalizeChineseText('你好啊！！！'), '你好!');
  assert.equal(normalizeChineseText('这个boss有点难打，，，'), '这个boss有点难打,');
});

test('normalizeChineseText：句首/句尾语气词剥离，句尾标点保留在原位置', () => {
  assert.equal(normalizeChineseText('啊呀，你好'), ',你好');
  assert.equal(normalizeChineseText('对啊？'), '对?');
  assert.equal(normalizeChineseText('好的呢。'), '好的.');
});

test('normalizeChineseText："吧"/"了" 不在语气词白名单里，不会被剥离', () => {
  assert.equal(normalizeChineseText('走吧'), '走吧');
  assert.equal(normalizeChineseText('打完了'), '打完了');
});

test('normalizeChineseText：重复吐字/口吃压缩为一次出现，覆盖单字和多字词组', () => {
  assert.equal(normalizeChineseText('我我我要去打野'), '我要去打野');
  assert.equal(normalizeChineseText('然后然后我们就去了'), '然后我们就去了');
});

test('normalizeChineseText：重复压缩只认中文字符，不会误伤中英混杂文本里的英文单词', () => {
  // 曾经的 bug：不限字符集的重复压缩把 "boss" 里的 "ss" 当成重复子串，压成了 "bos"。
  assert.equal(normalizeChineseText('这个boss有点难打'), '这个boss有点难打');
});

test('normalizeChineseText：空白归一化——全角空格、连续空格合并，首尾 trim', () => {
  assert.equal(normalizeChineseText('　　全角空格    多空格   '), '全角空格 多空格');
});

test('normalizeChineseText：纯语气词/噪音规范化后是空字符串', () => {
  assert.equal(normalizeChineseText('啊啊啊'), '');
  assert.equal(normalizeChineseText('啊呀'), '');
});

test('normalizeChineseText：四条规则按固定顺序组合作用于同一段文本', () => {
  // 全角标点→半角、语气词剥离、重复压缩、空白归一化，一起在同一句话上验证。
  assert.equal(normalizeChineseText('啊啊，我我我不知道呢！！！'), ',我不知道!');
});

test('buildTranslateCacheKey：带 translate: 前缀，相同输入产出相同 key（确定性）', () => {
  const params = { gameId: 'whiteout', srcLang: 'zh', tgtLang: 'en', normalizedText: '你好' };
  const key1 = buildTranslateCacheKey(params);
  const key2 = buildTranslateCacheKey(params);

  assert.ok(key1.startsWith('translate:'));
  assert.equal(key1, key2);
});

test('buildTranslateCacheKey：game_id/src_lang/tgt_lang/normalized_text 任一维度不同，key 就不同', () => {
  const base = { gameId: 'whiteout', srcLang: 'zh', tgtLang: 'en', normalizedText: '你好' };
  const base_key = buildTranslateCacheKey(base);

  assert.notEqual(buildTranslateCacheKey({ ...base, gameId: 'other-game' }), base_key);
  assert.notEqual(buildTranslateCacheKey({ ...base, tgtLang: 'fr' }), base_key);
  assert.notEqual(buildTranslateCacheKey({ ...base, normalizedText: '你好呀' }), base_key);
});
