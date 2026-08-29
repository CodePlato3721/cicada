// domain/translation-prompt.js 是纯函数（构造 chat messages 数组，不涉及网络调用），
// 直接断言返回结构和关键文案。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTranslationMessages } from '../../../dist/domain/translation-prompt.js';

test('buildTranslationMessages：返回 system + user 两条消息，user 内容原样包进 <source>', () => {
  const messages = buildTranslationMessages('Hello world', 'zh');

  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'user');
  assert.equal(messages[1].content, '<source>\nHello world\n</source>');
});

test('buildTranslationMessages：zh target 在 prompt 中 hardcode 成 zh-TW', () => {
  const messages = buildTranslationMessages('Hello', 'zh');
  assert.ok(messages[0].content.includes('to zh-TW'));
  assert.ok(!messages[0].content.includes('Chinese'));
});

test('buildTranslationMessages：任意语言代码原样透传，不报错', () => {
  const messages = buildTranslationMessages('Hello', 'xx');
  assert.ok(messages[0].content.includes('to xx'));
});

test('buildTranslationMessages：文本包含 <keep> 标签时追加保留说明；没有则不追加', () => {
  const withKeep = buildTranslationMessages('<keep>茉莉</keep> joined the alliance', 'en');
  const withoutKeep = buildTranslationMessages('Molly joined the alliance', 'en');

  assert.ok(withKeep[0].content.includes('Text inside <keep> tags is already translated to en'));
  assert.ok(withKeep[0].content.includes('keeping <keep> tags'));
  assert.ok(!withoutKeep[0].content.includes('Text inside <keep> tags'));
  assert.ok(withoutKeep[0].content.includes('No explanations, no quotes, no tags, nothing else.'));
});
