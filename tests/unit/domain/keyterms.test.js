// domain/keyterms.js 的 getKeyterms 是纯函数（词表在模块加载时一次性读好，调用时不做
// IO），用 src/domain/keyterms/whiteout.json 真实存在的文件驱动测试——当前这份文件是
// 空数组（见文件内注释，跟 terminology/whiteout.json 一样是"结构先搭好，内容等真实
// 游戏黑话整理好再填"），所以这里只能断言"空词表"这个场景 + 截断/边界逻辑本身，等
// whiteout.json 有真实内容之后可以再补"确实返回了词表里的词"这条断言。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getKeyterms } from '../../../dist/domain/keyterms.js';

test('getKeyterms：gameId 未设置（undefined）返回空数组', () => {
  assert.deepEqual(getKeyterms(undefined), []);
});

test('getKeyterms：没有对应词表的 game id 返回空数组，不抛错', () => {
  assert.deepEqual(getKeyterms('not-a-real-game'), []);
});

test('getKeyterms：已登记的游戏（whiteout）词表当前是空数组', () => {
  assert.deepEqual(getKeyterms('whiteout'), []);
});

test('getKeyterms：limit 参数会截断返回的词表长度', () => {
  // whiteout.json 现在是空的，用一个够大的 limit 也应该还是空数组——这里主要确认
  // 传自定义 limit 不会抛错、返回类型仍然是数组。
  const result = getKeyterms('whiteout', 5);
  assert.ok(Array.isArray(result));
  assert.ok(result.length <= 5);
});
