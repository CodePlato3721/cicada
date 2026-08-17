// domain/terminology.js 的 applyTerminology/stripKeepTags 是纯函数（词典在模块加载时
// 一次性编译好，调用时不做 IO/网络请求），用 src/domain/terminology/whiteout.json 里
// 真实存在的词条驱动测试，不需要 mock 词典数据。
//
// 注意：这里断言用到的具体词条（HERO_MOLLY / HERO_GORDON / BUILDING_BARRICADE）来自
// whiteout.json 当前内容，如果以后这些 term_id 被改名/删除，对应测试需要跟着更新。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTerminology, stripKeepTags } from '../../../dist/domain/terminology.js';

test('applyTerminology：text/sourceLang/game 任一缺失就直接跳过，不改动文本', () => {
  assert.deepEqual(applyTerminology('', 'en', 'zh', 'whiteout'), { text: '', hitCount: 0 });
  assert.deepEqual(applyTerminology('Molly joined', undefined, 'zh', 'whiteout'), {
    text: 'Molly joined',
    hitCount: 0,
  });
  assert.deepEqual(applyTerminology('Molly joined', 'en', 'zh', undefined), {
    text: 'Molly joined',
    hitCount: 0,
  });
});

test('applyTerminology：命中英文词条，替换成目标语言译词并用 <keep> 包裹', () => {
  const result = applyTerminology('Molly joined the alliance', 'en', 'zh', 'whiteout');

  assert.equal(result.hitCount, 1);
  assert.equal(result.text, '<keep>茉莉</keep> joined the alliance');
});

test('applyTerminology：拉丁字母语言按词边界匹配，不会命中词的一部分', () => {
  // "Mollycoddle" 不应该被误判成命中了 "Molly"——en 不在 NO_WORD_BOUNDARY_LANGS 里，
  // 必须整词匹配。
  const result = applyTerminology('Do not mollycoddle the new recruits', 'en', 'zh', 'whiteout');
  assert.equal(result.hitCount, 0);
  assert.equal(result.text, 'Do not mollycoddle the new recruits');
});

test('applyTerminology：源语言等于目标语言时，命中词原样保留，不包 <keep>（也不计入 hitCount）', () => {
  const result = applyTerminology('Molly joined the alliance', 'en', 'en', 'whiteout');
  assert.equal(result.hitCount, 0);
  assert.equal(result.text, 'Molly joined the alliance');
});

test('applyTerminology：中文源文本先正规化成繁体再匹配，简体输入也能命中繁体词典', () => {
  // HERO_GORDON 词典里的 zh 译法是繁体"哥頓"，这里故意传简体"哥顿"验证归一化。
  const result = applyTerminology('哥顿加入了联盟', 'zh', 'en', 'whiteout');

  assert.equal(result.hitCount, 1);
  assert.ok(result.text.includes('<keep>Gordon</keep>'));
});

test('applyTerminology：游戏 id 没有对应词典（或压根没登记）时跳过检测', () => {
  const result = applyTerminology('Molly joined the alliance', 'en', 'zh', 'not-a-real-game');
  assert.equal(result.hitCount, 0);
  assert.equal(result.text, 'Molly joined the alliance');
});

test('applyTerminology：一段话命中多个词条，逐个替换', () => {
  const result = applyTerminology('Molly attacked the Barricade', 'en', 'zh', 'whiteout');

  assert.equal(result.hitCount, 2);
  assert.equal(result.text, '<keep>茉莉</keep> attacked the <keep>城牆</keep>');
});

test('stripKeepTags：去掉 <keep> 标签本身，保留标签内的文字', () => {
  assert.equal(stripKeepTags('<keep>茉莉</keep> joined the alliance'), '茉莉 joined the alliance');
  assert.equal(stripKeepTags('no tags here'), 'no tags here');
  assert.equal(stripKeepTags('<keep>A</keep> and <keep>B</keep>'), 'A and B');
});
