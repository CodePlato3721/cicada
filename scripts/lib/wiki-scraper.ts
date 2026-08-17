// whiteoutsurvival.wiki 专用的抓取核心——从两次人工抓取（英雄、活动）里提炼出来的
// 四个步骤：抓列表页 → 核实"分页链接是不是假的" → 用 hreflang 互链找中文名 → 清洗。
// 纯函数/纯 I/O，不读也不写 src/domain/terminology/ 下的任何文件，跟"要不要收进
// 词典"这个决定完全解耦，那部分逻辑在 scrape-terms.js 里。

// wiki 站点标题固定带这个后缀（"事件名 - 寒霜啟示錄"），去掉它才是纯粹的中文名。
// 这是 whiteoutsurvival.wiki 这一个站点的specifics，换了别的 wiki 来源这个常量要跟着改。
const SITE_TITLE_SUFFIX = /\s*-\s*寒霜啟示錄\s*$/;

// 韩文/阿拉伯语等其他语言页面的标题后缀，跟繁体中文不一样——繁体中文那边后缀是
// 本地化过的游戏名"寒霜啟示錄"（见 SITE_TITLE_SUFFIX），韩文/阿拉伯语页面只是简单
// 加了英文站名，不本地化，所以后缀统一是这个（实测 ko/arb 页面标题验证过）。
const GENERIC_TITLE_SUFFIX = /\s*-\s*Whiteout Survival Wiki\s*$/i;

const USER_AGENT = 'Mozilla/5.0 (compatible; cicada-terminology-scraper/1.0)';

export async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#038;/g, '&')
    .replace(/&amp;/g, '&');
}

// 一张列表页卡片：slug 是详情页 URL 的最后一段路径，name 是卡片上显示的名字。
export interface WikiCard {
  slug: string;
  name: string;
}

// 列表页里每张卡片长这样（英雄页、活动页都是这个结构，同一个 WordPress 主题）：
//   href="<listUrl><slug>/" class="text-decoration-none text-light stretched-link notranslate">名字</a>
// 用同一个 slug 可能因为 tier/分类 tab 各出现一次，按 slug 去重。
function parseCards(html: string, listUrl: string): WikiCard[] {
  const regex = new RegExp(
    `href="${escapeRegExp(listUrl)}([^"/]+)/"\\s+class="text-decoration-none[^>]*>([^<]+)</a>`,
    'g',
  );
  const seen = new Map<string, string>(); // slug -> name
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html))) {
    const [, slug, name] = match;
    if (!seen.has(slug)) seen.set(slug, decodeEntities(name));
  }
  return [...seen.entries()].map(([slug, name]) => ({ slug, name }));
}

// 抓英文列表页，返回 [{ slug, name }]。
export async function fetchListPage(listUrl: string): Promise<WikiCard[]> {
  const html = await fetchText(listUrl);
  return parseCards(html, listUrl);
}

export type PaginationCheck =
  | { checked: false }
  | { checked: true; consistent: boolean; page2Count: number };

// 核实"page/2/"这类分页链接是不是真的有更多内容——活动页踩过这个坑：链接存在，
// 但内容跟第一页一模一样（模板遗留的死链接）。返回:
//   { checked: false }                        — 没有 page/2（本来就只有一页，正常）
//   { checked: true, consistent: true }        — 有 page/2，但内容跟第一页相同，可以放心只用第一页
//   { checked: true, consistent: false, ... }  — 内容不一样，真的有更多数据，需要人工处理翻页
export async function verifyNoHiddenPagination(listUrl: string, firstPageSlugs: string[]): Promise<PaginationCheck> {
  const page2Url = `${listUrl}page/2/`;
  let page2Html: string;
  try {
    page2Html = await fetchText(page2Url);
  } catch {
    return { checked: false };
  }
  const page2Slugs = new Set(parseCards(page2Html, listUrl).map((c) => c.slug));
  const firstSet = new Set(firstPageSlugs);
  const consistent =
    firstSet.size === page2Slugs.size && [...firstSet].every((slug) => page2Slugs.has(slug));
  return { checked: true, consistent, page2Count: page2Slugs.size };
}

// 逐个英文详情页找 hreflang="tw" 互链，跳转过去从 <title> 摘中文名——两次实操
// 验证过唯一可靠的配对方式（URL slug、图片文件名、列表顺序对齐都试过，都不可靠）。
// 找不到 hreflang（这个词条还没有中文页面）返回 null。
export async function resolveZhName(enDetailUrl: string): Promise<string | null> {
  const enHtml = await fetchText(enDetailUrl);
  const hreflangMatch = enHtml.match(/<link rel="alternate" href="([^"]+)" hreflang="tw"\s*\/>/);
  if (!hreflangMatch) return null;

  const zhHtml = await fetchText(hreflangMatch[1]);
  const titleMatch = zhHtml.match(/<title>([^<]+)<\/title>/);
  if (!titleMatch) return null;

  return decodeEntities(titleMatch[1]).replace(SITE_TITLE_SUFFIX, '').trim();
}

// 从一份已经抓好的英文详情页 HTML 里，一次性找出多个 hreflang 代码各自对应的互链地址。
// 跟 resolveZhName 分开设计（不是让 resolveZhName 支持传参数复用），是因为要支持"一次
// fetch 英文详情页、同时找多个语言的互链"——给一个词条同时补韩文+阿拉伯语时，只用请求
// 一次英文详情页，不用每加一个语言就重新请求一次。
export function extractHreflangLinks(enHtml: string, hreflangCodes: string[]): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const code of hreflangCodes) {
    const re = new RegExp(`<link rel="alternate" href="([^"]+)" hreflang="${escapeRegExp(code)}"\\s*/?>`);
    const match = enHtml.match(re);
    result[code] = match ? match[1] : null;
  }
  return result;
}

// 给定一个页面 URL，抓取并从 <title> 摘出名字、去掉站点固定后缀。suffixPattern 默认是
// 韩文/阿拉伯语这类"简单加英文站名"的后缀；繁体中文那种本地化后缀请继续用 resolveZhName。
export async function resolveTitleFromUrl(url: string, suffixPattern: RegExp = GENERIC_TITLE_SUFFIX): Promise<string | null> {
  const html = await fetchText(url);
  const titleMatch = html.match(/<title>([^<]+)<\/title>/);
  if (!titleMatch) return null;
  return decodeEntities(titleMatch[1]).replace(suffixPattern, '').trim();
}

// 规则明确、可以放心自动做的清洗——只做这一件事：弯引号统一成直引号（配合 Deepgram
// smart_format 的标点习惯）。刻意不在这里做"去括号注解""简化缩写"这类需要语境判断
// 的清洗，那些留给人工审核阶段（见 CLAUDE.md 和 merge-terms.js 的工作流）。
export function cleanText(name: string): string {
  return name.replace(/[\u2018\u2019]/g, "'").trim();
}

// 科技类词条常见"基础名 + 罗马数字等级后缀"（比如 "Lancer Armor I"/"Lancer Armor II"）。
// 同一个黑话译法不会因为等级变化，收录每个等级各一条纯属浪费词典条目，没有额外的翻译
// 准确性收益——只收基础名字，等级后缀在这一步去掉（scrape-terms.js 再按去掉后缀的
// 名字去重，同一个基础名只保留第一次出现的那条）。
// 用严格的罗马数字构造规则（不是"整串字符都属于 IVXLCDM 集合"这种粗糙判断），避免
// 误伤真的以这几个字母结尾的普通词（比如 "MILD" 不会被误判成罗马数字）。
//
// 这个 wiki 的科技类页面（research）不是用 ASCII 字母拼罗马数字（"I"+"I"+"I"），
// 而是用 Unicode「罗马数字」专用区块里的单个字符（比如 "Ⅲ" 是 U+2162 这一个字符，
// 不是三个 "I"）——ASCII 正则完全匹配不到这种字符，第一版漏了这个情况，导致
// "Molten Vambrace"/"Molten Vambrace Ⅱ"/"Molten Vambrace Ⅲ" 被当成三个不同的词，
// 一个都没被去重（实测 research 分类 113 条草稿里有 24 条受影响）。这里把这两种
// 罗马数字的写法都覆盖到。
const UNICODE_ROMAN_NUMERALS = 'ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹⅺⅻ';
const TIER_SUFFIX = new RegExp(
  `\\s+(?:(M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3}))|([${UNICODE_ROMAN_NUMERALS}]))$`,
  'i',
);

export function stripTierSuffix(name: string): string {
  const match = name.match(TIER_SUFFIX);
  // 两个分支各自一个捕获组（ASCII 罗马数字 match[1] / Unicode 罗马数字字符 match[2]），
  // 命中哪个分支都算数，只要有一个非空就说明真的匹配到了等级后缀。
  if (!match || (!match[1] && !match[2])) return name;
  return name.slice(0, match.index ?? 0).trim();
}

export function toTermId(idPrefix: string, name: string): string {
  const slug = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${idPrefix}_${slug}`;
}

// 小并发池——避免对 wiki 服务器一次性发几十上百个请求。默认 5 并发，跟之前人工
// 抓取时验证过的节奏一致。
export async function pool<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function run(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, run));
  return results;
}
