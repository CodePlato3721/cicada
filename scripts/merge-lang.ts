import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getSource } from './wiki-sources.js';

interface DictEntry {
  term_id: string;
  translations: Record<string, string | string[] | undefined>;
}

type LangPatch = { term_id: string } & Record<string, string | undefined>;

const projectRoot = process.cwd();

const args = process.argv.slice(2);
const sourceId = args[0];
const langs = args.slice(1);
if (!sourceId || langs.length === 0) {
  console.error('Usage: node scripts/merge-lang.js <source id> <lang code...>');
  process.exit(1);
}

const source = getSource(sourceId);
const patchPath = path.join(projectRoot, `scripts/drafts/${source.id}.${langs.join('-')}.patch.json`);
if (!existsSync(patchPath)) {
  console.error(`Patch file not found: ${patchPath} — run node scripts/scrape-lang.js ${source.id} ${langs.join(' ')} first`);
  process.exit(1);
}

const dictPath = path.join(projectRoot, `src/domain/terminology/${source.game}.json`);
const dict: DictEntry[] = JSON.parse(readFileSync(dictPath, 'utf-8'));
const patch: LangPatch[] = JSON.parse(readFileSync(patchPath, 'utf-8'));

const byTermId = new Map(dict.map((e) => [e.term_id, e]));

let updated = 0;
let notFound = 0;
for (const p of patch) {
  const entry = byTermId.get(p.term_id);
  if (!entry) {
    console.warn(`term_id "${p.term_id}" not found in dictionary, skipping (dictionary may have changed since the patch was generated)`);
    notFound += 1;
    continue;
  }
  for (const lang of langs) {
    const value = p[lang];
    if (value) entry.translations[lang] = value;
  }
  updated += 1;
}

writeFileSync(dictPath, JSON.stringify(dict, null, 2) + '\n');
console.log(`Added ${langs.join('/')} field(s) to ${updated} entr(y/ies) (${dictPath})`);
if (notFound > 0) console.log(`${notFound} entr(y/ies) had no matching term_id in the dictionary, skipped`);
