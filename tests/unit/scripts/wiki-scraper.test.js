// scripts/lib/wiki-scraper.ts 里不涉及网络 I/O 的纯函数——cleanText/stripTierSuffix/
// toTermId/extractHreflangLinks/pool。fetchText/fetchListPage/resolveZhName/
// resolveTitleFromUrl/verifyNoHiddenPagination 都要发真实 HTTP 请求，不在这里测。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, stripTierSuffix, toTermId, extractHreflangLinks, pool } from '../../../dist/scripts/lib/wiki-scraper.js';

test('cleanText：弯引号统一成直引号，并去掉首尾空白', () => {
  assert.equal(cleanText(' It’s a "trap" '), "It's a \"trap\"");
});

test('stripTierSuffix：去掉 ASCII 罗马数字等级后缀', () => {
  assert.equal(stripTierSuffix('Lancer Armor III'), 'Lancer Armor');
  assert.equal(stripTierSuffix('Lancer Armor I'), 'Lancer Armor');
});

test('stripTierSuffix：去掉 Unicode 罗马数字专用字符后缀（不是 ASCII 字母拼出来的）', () => {
  assert.equal(stripTierSuffix('Molten Vambrace Ⅲ'), 'Molten Vambrace'); // Ⅲ
});

test('stripTierSuffix：没有等级后缀的名字原样返回，不误伤以 I/V/M 结尾的普通词', () => {
  assert.equal(stripTierSuffix('MILD'), 'MILD');
  assert.equal(stripTierSuffix('Frostfire'), 'Frostfire');
});

test('toTermId：非字母数字字符折叠成下划线，并加上 idPrefix', () => {
  assert.equal(toTermId('HERO', "Charlie's Gambit"), 'HERO_CHARLIE_S_GAMBIT');
});

test('extractHreflangLinks：按传入的 hreflang 代码各自找互链，找不到的返回 null', () => {
  const html = `
    <link rel="alternate" href="https://example.com/ko/x/" hreflang="ko" />
    <link rel="alternate" href="https://example.com/tw/x/" hreflang="tw" />
  `;
  const links = extractHreflangLinks(html, ['ko', 'arb']);
  assert.equal(links.ko, 'https://example.com/ko/x/');
  assert.equal(links.arb, null);
});

test('pool：按给定并发数跑完所有任务，结果顺序跟输入顺序一致（不是完成顺序）', async () => {
  const items = [30, 10, 20];
  const results = await pool(items, 2, async (ms) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return ms;
  });
  assert.deepEqual(results, [30, 10, 20]);
});
