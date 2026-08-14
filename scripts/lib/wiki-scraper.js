// whiteoutsurvival.wiki 专用的抓取核心——从两次人工抓取（英雄、活动）里提炼出来的
// 四个步骤：抓列表页 → 核实"分页链接是不是假的" → 用 hreflang 互链找中文名 → 清洗。
// 纯函数/纯 I/O，不读也不写 src/domain/terminology/ 下的任何文件，跟"要不要收进
// 词典"这个决定完全解耦，那部分逻辑在 scrape-terms.js 里。

// wiki 站点标题固定带这个后缀（"事件名 - 寒霜啟示錄"），去掉它才是纯粹的中文名。
// 这是 whiteoutsurvival.wiki 这一个站点的specifics，换了别的 wiki 来源这个常量要跟着改。
const SITE_TITLE_SUFFIX = /\s*-\s*寒霜啟示錄\s*$/;

const USER_AGENT = 'Mozilla/5.0 (compatible; cicada-terminology-scraper/1.0)';

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}：${url}`);
  return res.text();
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#038;/g, '&')
    .replace(/&amp;/g, '&');
}

// 列表页里每张卡片长这样（英雄页、活动页都是这个结构，同一个 WordPress 主题）：
//   href="<listUrl><slug>/" class="text-decoration-none text-light stretched-link notranslate">名字</a>
// 用同一个 slug 可能因为 tier/分类 tab 各出现一次，按 slug 去重。
function parseCards(html, listUrl) {
  const regex = new RegExp(
    `href="${escapeRegExp(listUrl)}([^"/]+)/"\\s+class="text-decoration-none[^>]*>([^<]+)</a>`,
    'g',
  );
  const seen = new Map(); // slug -> name
  let match;
  while ((match = regex.exec(html))) {
    const [, slug, name] = match;
    if (!seen.has(slug)) seen.set(slug, decodeEntities(name));
  }
  return [...seen.entries()].map(([slug, name]) => ({ slug, name }));
}

// 抓英文列表页，返回 [{ slug, name }]。
export async function fetchListPage(listUrl) {
  const html = await fetchText(listUrl);
  return parseCards(html, listUrl);
}

// 核实"page/2/"这类分页链接是不是真的有更多内容——活动页踩过这个坑：链接存在，
// 但内容跟第一页一模一样（模板遗留的死链接）。返回:
//   { checked: false }                        — 没有 page/2（本来就只有一页，正常）
//   { checked: true, consistent: true }        — 有 page/2，但内容跟第一页相同，可以放心只用第一页
//   { checked: true, consistent: false, ... }  — 内容不一样，真的有更多数据，需要人工处理翻页
export async function verifyNoHiddenPagination(listUrl, firstPageSlugs) {
  const page2Url = `${listUrl}page/2/`;
  let page2Html;
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
export async function resolveZhName(enDetailUrl) {
  const enHtml = await fetchText(enDetailUrl);
  const hreflangMatch = enHtml.match(/<link rel="alternate" href="([^"]+)" hreflang="tw"\s*\/>/);
  if (!hreflangMatch) return null;

  const zhHtml = await fetchText(hreflangMatch[1]);
  const titleMatch = zhHtml.match(/<title>([^<]+)<\/title>/);
  if (!titleMatch) return null;

  return decodeEntities(titleMatch[1]).replace(SITE_TITLE_SUFFIX, '').trim();
}

// 规则明确、可以放心自动做的清洗——只做这一件事：弯引号统一成直引号（配合 Deepgram
// smart_format 的标点习惯）。刻意不在这里做"去括号注解""简化缩写"这类需要语境判断
// 的清洗，那些留给人工审核阶段（见 CLAUDE.md 和 merge-terms.js 的工作流）。
export function cleanText(name) {
  return name.replace(/[\u2018\u2019]/g, "'").trim();
}

export function toTermId(idPrefix, name) {
  const slug = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${idPrefix}_${slug}`;
}

// 小并发池——避免对 wiki 服务器一次性发几十上百个请求。默认 5 并发，跟之前人工
// 抓取时验证过的节奏一致。
export async function pool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, run));
  return results;
}
