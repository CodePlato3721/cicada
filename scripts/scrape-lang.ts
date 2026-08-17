// 用法：
//   node scripts/scrape-lang.js heroes ko ar
//   node scripts/scrape-lang.js --all ko ar
//
// 跟 scrape-terms.js 不一样：这个脚本不新增词条，是给 src/domain/terminology/<game>.json
// 里已经存在的词条补充新语言字段（比如 ko/ar）。合并后的词典只存 term_id+translations，
// 没留原始 wiki 详情页 URL，所以要重新走一遍列表页抓取拿 slug、重建详情页地址，再从
// 详情页找 hreflang 互链——跟 scrape-terms.js 走的是同一套列表页抓取逻辑（fetchListPage/
// stripTierSuffix），只是不新建词条，改成按"清洗+去等级后缀"之后的名字回头匹配已有
// term_id。
//
// 语言代码用法：这个脚本的参数、以及生成的草稿字段名，用的是我们自己 App 内部的 ISO 码
// （比如 'ar'），不是 wiki 网站自己的 hreflang 代码（阿拉伯语官网标的是 'arb'）——两者
// 在 LANG_HREFLANG 这张表里做映射，其余地方只出现我们自己的语言码，避免自己代码里混进
// 网站特定的命名习惯。
//
// 抓完不直接改词典，写到 scripts/drafts/<source>.<lang>.patch.json 里等人工审核，审核完
// 用 `node scripts/merge-lang.js <source> <lang1> <lang2> ...` 合并——合并是"给已有
// term_id 加字段"，不是追加新词条，所以用专门的合并脚本，不能跟 merge-terms.js 混用。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SOURCES, getSource } from './wiki-sources.js';
import {
  fetchListPage,
  fetchText,
  extractHreflangLinks,
  resolveTitleFromUrl,
  cleanText,
  stripTierSuffix,
  pool,
} from './lib/wiki-scraper.js';

// 见 merge-terms.ts 顶部注释：编译产物跑在 dist/scripts/ 下，跟源码目录深度不一样，
// 锚定 process.cwd()（npm script 固定从项目根目录调用）比按 __dirname 手算相对
// 路径更稳。
const projectRoot = process.cwd();
const DRAFTS_DIR = path.join(projectRoot, 'scripts/drafts');

interface DictEntry {
  term_id: string;
  translations: Record<string, string | string[] | undefined>;
}

// term_id 恒有；error 只在抓取失败时出现；其余 key 是按语言码动态写入的译名字段。
interface LangPatchResult {
  term_id: string;
  error?: string;
  [lang: string]: string | undefined;
}

interface ScrapeTask {
  slug: string;
  termId: string;
}

// 我们自己的语言码 -> 这个 wiki 网站的 hreflang 代码。目前只有阿拉伯语不一致。
const LANG_HREFLANG: Record<string, string> = {
  ko: 'ko',
  ar: 'arb',
};

function canonicalEn(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// 已有词典里的英文名，跟列表页抓出来的名字一样要走"清洗 + 去等级后缀"才能对上——
// 词典里存的就是已经处理过的版本（见 scrape-terms.js）。
function loadTermIdByBaseName(game: string, idPrefix: string): Map<string, string> {
  const filePath = path.join(projectRoot, `src/domain/terminology/${game}.json`);
  if (!existsSync(filePath)) {
    throw new Error(`Dictionary file not found: ${filePath}`);
  }
  const entries: DictEntry[] = JSON.parse(readFileSync(filePath, 'utf-8'));
  const map = new Map<string, string>(); // 清洗后的英文名(小写) -> term_id
  for (const entry of entries) {
    if (!entry.term_id.startsWith(`${idPrefix}_`)) continue;
    const en = canonicalEn(entry.translations.en);
    if (en) map.set(en.toLowerCase(), entry.term_id);
  }
  return map;
}

async function scrapeLangForSource(sourceId: string, langs: string[]): Promise<void> {
  const source = getSource(sourceId);
  const hreflangCodes = langs.map((l) => LANG_HREFLANG[l]);
  console.log(`\n=== Supplementing language(s): ${source.id} (${langs.join('/')}) ===`);

  const cards = await fetchListPage(source.listUrl);
  console.log(`Found ${cards.length} entr(y/ies) on the list page`);

  const termIdByBaseName = loadTermIdByBaseName(source.game, source.idPrefix);
  console.log(`Entries in dictionary starting with ${source.idPrefix}_: ${termIdByBaseName.size}`);

  const seenTermIds = new Set<string>(); // 同一个 term_id 只处理一次（等级变体去重，跟 scrape-terms.js 一致）
  const tasks: ScrapeTask[] = [];
  for (const { slug, name } of cards) {
    const baseName = stripTierSuffix(cleanText(name));
    const termId = termIdByBaseName.get(baseName.toLowerCase());
    if (!termId || seenTermIds.has(termId)) continue;
    seenTermIds.add(termId);
    tasks.push({ slug, termId });
  }
  console.log(`Matched to dictionary entries: ${tasks.length}`);

  const results = await pool(tasks, 5, async ({ slug, termId }): Promise<LangPatchResult> => {
    const enDetailUrl = `${source.listUrl}${slug}/`;
    try {
      const enHtml = await fetchText(enDetailUrl);
      const links = extractHreflangLinks(enHtml, hreflangCodes);
      const patch: LangPatchResult = { term_id: termId };
      for (const lang of langs) {
        const url = links[LANG_HREFLANG[lang]];
        if (!url) continue;
        const title = await resolveTitleFromUrl(url);
        if (title) patch[lang] = stripTierSuffix(cleanText(title));
      }
      return patch;
    } catch (e) {
      return { term_id: termId, error: String(e) };
    }
  });

  const draft = results.filter((r) => !r.error && langs.some((l) => r[l]));
  const failed = results.filter((r) => r.error);
  const noTranslation = results.filter((r) => !r.error && !langs.some((l) => r[l]));

  // 词典里存在、但这次列表页抓取没能匹配回去的 term_id——大概率是之前人工新建/改名过
  // 的"基础名"词条（比如去掉 Exalted/煌耀 品阶前缀之后合成的那批），wiki 上没有对应
  // 的单独页面，没法通过这套 hreflang 机制自动补语言，需要人工另外处理。
  const unmatchedExisting = [...termIdByBaseName.values()].filter((id) => !seenTermIds.has(id));

  mkdirSync(DRAFTS_DIR, { recursive: true });
  const draftPath = path.join(DRAFTS_DIR, `${source.id}.${langs.join('-')}.patch.json`);
  writeFileSync(draftPath, JSON.stringify(draft, null, 2) + '\n');

  console.log(`Added language field(s): ${draft.length} entr(y/ies)`);
  console.log(`Failed to scrape: ${failed.length} entr(y/ies)${failed.length ? ': ' + failed.map((f) => f.term_id).join(', ') : ''}`);
  console.log(`Matched but no target-language page found: ${noTranslation.length} entr(y/ies)${noTranslation.length ? ': ' + noTranslation.map((f) => f.term_id).join(', ') : ''}`);
  console.log(
    `Exists in dictionary but not matched this run (may be a manually-composed base-name entry, needs separate handling): ${unmatchedExisting.length} entr(y/ies)` +
      `${unmatchedExisting.length ? ': ' + unmatchedExisting.join(', ') : ''}`,
  );
  if (draft.length > 0) {
    console.log(`\nWritten to ${draftPath}. After manual review, run:`);
    console.log(`  node scripts/merge-lang.js ${source.id} ${langs.join(' ')}`);
  }
}

const args = process.argv.slice(2);
const allIndex = args.indexOf('--all');
const isAll = allIndex !== -1;
if (isAll) args.splice(allIndex, 1);

// 剩下的参数里，凡是 LANG_HREFLANG 认识的就当语言码，其余当分类 id。
const langs = args.filter((a) => LANG_HREFLANG[a]);
const targetIds = isAll ? SOURCES.map((s) => s.id) : args.filter((a) => !LANG_HREFLANG[a]);

if (langs.length === 0 || targetIds.length === 0) {
  console.error(`Usage: node scripts/scrape-lang.js <category id or --all> <lang code...(${Object.keys(LANG_HREFLANG).join('|')})>`);
  process.exit(1);
}

for (const id of targetIds) {
  await scrapeLangForSource(id, langs);
}
