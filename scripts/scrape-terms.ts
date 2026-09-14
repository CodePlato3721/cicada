import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SOURCES, getSource } from './wiki-sources.js';
import {
  fetchListPage,
  verifyNoHiddenPagination,
  resolveZhName,
  cleanText,
  stripTierSuffix,
  toTermId,
  pool,
} from './lib/wiki-scraper.js';

const projectRoot = process.cwd();
const DRAFTS_DIR = path.join(projectRoot, 'scripts/drafts');

interface DictEntry {
  term_id: string;
  translations: Record<string, string | string[] | undefined>;
}

interface ScrapedName {
  slug: string;
  en: string;
  zh: string | null;
  error?: string;
}

interface DraftEntry {
  term_id: string;
  translations: { en: string; zh: string };
  flags?: string[];
}

const COMMON_NAMES = new Set(
  [
    'James', 'John', 'Robert', 'Michael', 'David', 'William', 'Richard', 'Joseph', 'Thomas',
    'Charles', 'Mary', 'Patricia', 'Jennifer', 'Linda', 'Elizabeth', 'Barbara', 'Susan',
    'Jessica', 'Sarah', 'Karen', 'Charlie', 'Mia', 'Molly', 'Patrick', 'Wayne', 'Gordon',
    'Gina', 'Freya', 'Cara', 'Logan', 'Alex', 'Sam', 'Chris', 'Jamie', 'Max', 'Jack', 'Emma',
    'Olivia', 'Sophia', 'Isabella', 'Charlotte', 'Amelia', 'Grace', 'Lucy', 'Anna', 'Emily',
    'Ryan', 'Kevin', 'Brian', 'Jason', 'Justin', 'Eric', 'Adam', 'Nathan', 'Tyler', 'Aaron',
    'Henry', 'George', 'Edward', 'Frank', 'Alan', 'Peter', 'Paul', 'Mark', 'Steve', 'Andrew',
    'Daniel', 'Matthew',
  ].map((n) => n.toLowerCase()),
);

const UNUSUAL_PUNCTUATION = /[–—&]/;

function flagRisks(entry: DraftEntry): string[] {
  const flags: string[] = [];
  const firstWord = entry.translations.en.split(/\s+/)[0]?.toLowerCase();
  if (COMMON_NAMES.has(firstWord)) flags.push('common-name');
  if (UNUSUAL_PUNCTUATION.test(entry.translations.en) || UNUSUAL_PUNCTUATION.test(entry.translations.zh)) {
    flags.push('unusual-punctuation');
  }
  return flags;
}

function loadExistingEnNames(game: string): Set<string> {
  const filePath = path.join(projectRoot, `src/domain/terminology/${game}.json`);
  if (!existsSync(filePath)) return new Set();
  const entries: DictEntry[] = JSON.parse(readFileSync(filePath, 'utf-8'));
  return new Set(
    entries.flatMap((entry) => {
      const en = entry.translations?.en;
      const forms = Array.isArray(en) ? en : [en];
      return forms.filter((s): s is string => Boolean(s)).map((s) => s.toLowerCase());
    }),
  );
}

async function scrapeSource(sourceId: string): Promise<void> {
  const source = getSource(sourceId);
  console.log(`\n=== Scraping category: ${source.id} (${source.listUrl}) ===`);

  const cards = await fetchListPage(source.listUrl);
  console.log(`Found ${cards.length} entr(y/ies) on the list page`);

  const paginationCheck = await verifyNoHiddenPagination(source.listUrl, cards.map((c) => c.slug));
  if (paginationCheck.checked && !paginationCheck.consistent) {
    console.warn(
      `⚠ Warning: page/2/ content differs from page 1 (page 2 has ${paginationCheck.page2Count} entries) — this category may genuinely be paginated, ` +
        `the script currently only handles page 1, manually confirm whether to extend the scraping logic.`,
    );
  }

  const existingEnNames = loadExistingEnNames(source.game);

  const resolved: ScrapedName[] = await pool(cards, 5, async ({ slug, name }): Promise<ScrapedName> => {
    const enDetailUrl = `${source.listUrl}${slug}/`;
    try {
      const zhName = await resolveZhName(enDetailUrl);
      return {
        slug,
        en: stripTierSuffix(cleanText(name)),
        zh: zhName ? stripTierSuffix(cleanText(zhName)) : null,
      };
    } catch (e) {
      return { slug, en: cleanText(name), zh: null, error: String(e) };
    }
  });

  const unpaired = resolved.filter((r) => !r.zh);
  const paired = resolved.filter((r): r is ScrapedName & { zh: string } => r.zh !== null);

  const draft: DraftEntry[] = [];
  let skippedExisting = 0;
  let skippedTierDuplicate = 0;
  const seenThisRun = new Set<string>();
  for (const { en, zh } of paired) {
    const key = en.toLowerCase();
    if (existingEnNames.has(key)) {
      skippedExisting += 1;
      continue;
    }
    if (seenThisRun.has(key)) {
      skippedTierDuplicate += 1;
      continue;
    }
    seenThisRun.add(key);

    const entry: DraftEntry = { term_id: toTermId(source.idPrefix, en), translations: { en, zh } };
    const flags = flagRisks(entry);
    draft.push(flags.length > 0 ? { ...entry, flags } : entry);
  }

  mkdirSync(DRAFTS_DIR, { recursive: true });
  const draftPath = path.join(DRAFTS_DIR, `${source.id}.draft.json`);
  writeFileSync(draftPath, JSON.stringify(draft, null, 2) + '\n');

  const flaggedCount = draft.filter((e) => e.flags).length;
  console.log(`New: ${draft.length} entr(y/ies) (${flaggedCount} flagged as risky)`);
  console.log(`Already existing (skipped): ${skippedExisting} entr(y/ies)`);
  console.log(`Tier-suffix duplicates (skipped): ${skippedTierDuplicate} entr(y/ies)`);
  const unpairedUniqueNames = [...new Set(unpaired.map((u) => u.en))];
  console.log(
    `Unpaired (no Chinese page): ${unpaired.length} entr(y/ies), ${unpairedUniqueNames.length} distinct base name(s)` +
      `${unpairedUniqueNames.length ? ': ' + unpairedUniqueNames.join(', ') : ''}`,
  );
  if (draft.length > 0) {
    console.log(`\nWritten to ${draftPath}. After manual review (delete unwanted entries / fix entries flagged by "flags"), run:`);
    console.log(`  node scripts/merge-terms.js ${source.id}`);
  } else {
    console.log('No new entries, no review needed.');
  }
}

const args = process.argv.slice(2);
const targets = args.includes('--all') ? SOURCES.map((s) => s.id) : args;

if (targets.length === 0) {
  console.error(`Usage: node scripts/scrape-terms.js <${SOURCES.map((s) => s.id).join('|')}> or --all`);
  process.exit(1);
}

for (const id of targets) {
  await scrapeSource(id);
}
