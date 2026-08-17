import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SOURCES, getSource } from '../../../dist/scripts/wiki-sources.js';

test('getSource：已登记的分类 id 返回对应的 source 配置', () => {
  const source = getSource('heroes');
  assert.equal(source.game, 'whiteout');
  assert.equal(source.idPrefix, 'HERO');
});

test('getSource：未登记的分类 id 抛错，错误信息列出所有可选项', () => {
  assert.throws(() => getSource('not-a-real-source'), (err) => {
    assert.ok(err instanceof Error);
    for (const source of SOURCES) {
      assert.ok(err.message.includes(source.id));
    }
    return true;
  });
});
