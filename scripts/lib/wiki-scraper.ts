const SITE_TITLE_SUFFIX = /\s*-\s*寒霜啟示錄\s*$/;

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

export interface WikiCard {
  slug: string;
  name: string;
}

function parseCards(html: string, listUrl: string): WikiCard[] {
  const regex = new RegExp(
    `href="${escapeRegExp(listUrl)}([^"/]+)/"\\s+class="text-decoration-none[^>]*>([^<]+)</a>`,
    'g',
  );
  const seen = new Map<string, string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html))) {
    const [, slug, name] = match;
    if (!seen.has(slug)) seen.set(slug, decodeEntities(name));
  }
  return [...seen.entries()].map(([slug, name]) => ({ slug, name }));
}

export async function fetchListPage(listUrl: string): Promise<WikiCard[]> {
  const html = await fetchText(listUrl);
  return parseCards(html, listUrl);
}

export type PaginationCheck =
  | { checked: false }
  | { checked: true; consistent: boolean; page2Count: number };

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

export async function resolveZhName(enDetailUrl: string): Promise<string | null> {
  const enHtml = await fetchText(enDetailUrl);
  const hreflangMatch = enHtml.match(/<link rel="alternate" href="([^"]+)" hreflang="tw"\s*\/>/);
  if (!hreflangMatch) return null;

  const zhHtml = await fetchText(hreflangMatch[1]);
  const titleMatch = zhHtml.match(/<title>([^<]+)<\/title>/);
  if (!titleMatch) return null;

  return decodeEntities(titleMatch[1]).replace(SITE_TITLE_SUFFIX, '').trim();
}

export function extractHreflangLinks(enHtml: string, hreflangCodes: string[]): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const code of hreflangCodes) {
    const re = new RegExp(`<link rel="alternate" href="([^"]+)" hreflang="${escapeRegExp(code)}"\\s*/?>`);
    const match = enHtml.match(re);
    result[code] = match ? match[1] : null;
  }
  return result;
}

export async function resolveTitleFromUrl(url: string, suffixPattern: RegExp = GENERIC_TITLE_SUFFIX): Promise<string | null> {
  const html = await fetchText(url);
  const titleMatch = html.match(/<title>([^<]+)<\/title>/);
  if (!titleMatch) return null;
  return decodeEntities(titleMatch[1]).replace(suffixPattern, '').trim();
}

export function cleanText(name: string): string {
  return name.replace(/[\u2018\u2019]/g, "'").trim();
}

const UNICODE_ROMAN_NUMERALS = 'ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹⅺⅻ';
const TIER_SUFFIX = new RegExp(
  `\\s+(?:(M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3}))|([${UNICODE_ROMAN_NUMERALS}]))$`,
  'i',
);

export function stripTierSuffix(name: string): string {
  const match = name.match(TIER_SUFFIX);
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
