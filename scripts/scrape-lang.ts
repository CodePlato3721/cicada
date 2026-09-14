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

const projectRoot = process.cwd();
const DRAFTS_DIR = path.join(projectRoot, 'scripts/drafts');

interface DictEntry {
  term_id: string;
  translations: Record<string, string | string[] | undefined>;
}

interface LangPatchResult {
  term_id: string;
  error?: string;
  [lang: string]: string | undefined;
}

interface ScrapeTask {
  slug: string;
  termId: string;
}

const LANG_HREFLANG: Record<string, string> = {
  ko: 'ko',
  ar: 'arb',
};

function canonicalEn(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function loadTermIdByBaseName(game: string, idPrefix: string): Map<string, string> {
  const filePath = path.join(projectRoot, `src/domain/terminology/${game}.json`);
  if (!existsSync(filePath)) {
    throw new Error(`Dictionary file not found: ${filePath}`);
  }
  const entries: DictEntry[] = JSON.parse(readFileSync(filePath, 'utf-8'));
  const map = new Map<string, string>();
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

  const seenTermIds = new Set<string>();
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

const langs = args.filter((a) => LANG_HREFLANG[a]);
const targetIds = isAll ? SOURCES.map((s) => s.id) : args.filter((a) => !LANG_HREFLANG[a]);

if (langs.length === 0 || targetIds.length === 0) {
  console.error(`Usage: node scripts/scrape-lang.js <category id or --all> <lang code...(${Object.keys(LANG_HREFLANG).join('|')})>`);
  process.exit(1);
}

for (const id of targetIds) {
  await scrapeLangForSource(id, langs);
}
