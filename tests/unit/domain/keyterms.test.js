// domain/keyterms.js 的 getKeyterms 是纯函数（词表在模块加载时一次性读好，调用时不做
// IO），用 src/domain/keyterms/whiteout.json 和 hok.json 真实存在的文件驱动测试——
// whiteout.json 当前是空对象 {}（结构先搭好，内容等真实游戏黑话整理好再填），hok.json
// 已经有中文（zh）的分路关键词，用来验证"真的返回了词表里的词"这条路径。
//
// 2026-08-26：getKeyterms 加了"没有专门维护的语言回退到 'en' 词表"这条路径（source
// locale 扩到 79 个之后，不可能每种语言都手工整理 wiki 词表，见 keyterms.js 里
// getKeyterms 内部的注释）。hok.json 目前连 'en' 都没有整理，所以还不能用真实数据
// 写一个"真的从 en 拿到词"的测试，只能验证到"en 本身也缺失时回退无效、老实返回空数组"
// 这一步——等 whiteout.json/hok.json 任一填了 'en' 词表之后，应该在这里补一条"确实
// 从 en 拿到内容"的测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getKeyterms } from '../../../dist/domain/keyterms.js';

test('getKeyterms：gameId 未设置（undefined）返回空数组', () => {
  assert.deepEqual(getKeyterms(undefined, 'zh'), []);
});

test('getKeyterms：lang 未设置（undefined）返回空数组', () => {
  assert.deepEqual(getKeyterms('hok', undefined), []);
});

test('getKeyterms：没有对应词表的 game id 返回空数组，不抛错', () => {
  assert.deepEqual(getKeyterms('not-a-real-game', 'zh'), []);
});

test('getKeyterms：已登记的游戏（whiteout）在任意语言下词表当前都是空数组', () => {
  assert.deepEqual(getKeyterms('whiteout', 'zh'), []);
});

test('getKeyterms：游戏在这门语言下没有维护关键词（有其他语言但没有这门）返回空数组', () => {
  assert.deepEqual(getKeyterms('hok', 'en'), []);
});

test('getKeyterms：没有专门维护的语言（hok 只有 zh）回退到 en 词表，但 en 本身也没有整理，老实返回空数组', () => {
  assert.deepEqual(getKeyterms('hok', 'fr'), []);
});

test('getKeyterms：已登记的游戏 + 语言组合（hok/zh）返回词表里的真实内容', () => {
  const result = getKeyterms('hok', 'zh');
  assert.deepEqual(result, ['對抗路', '發育路', '打野', '中路', '輔助']);
});

test('getKeyterms：limit 参数会截断返回的词表长度', () => {
  const result = getKeyterms('hok', 'zh', 3);
  assert.deepEqual(result, ['對抗路', '發育路', '打野']);
});
