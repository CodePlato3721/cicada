import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getSource } from './wiki-sources.js';

interface DictEntry {
  term_id: string;
  translations: Record<string, string | string[] | undefined>;
}

interface DraftEntry extends DictEntry {
  flags?: string[];
}

const projectRoot = process.cwd();

const sourceId = process.argv[2];
if (!sourceId) {
  console.error('Usage: node scripts/merge-terms.js <source id>');
  process.exit(1);
}

const source = getSource(sourceId);
const draftPath = path.join(projectRoot, `scripts/drafts/${source.id}.draft.json`);
if (!existsSync(draftPath)) {
  console.error(`Draft file not found: ${draftPath} — run node scripts/scrape-terms.js ${source.id} first`);
  process.exit(1);
}

const dictPath = path.join(projectRoot, `src/domain/terminology/${source.game}.json`);
const existing: DictEntry[] = JSON.parse(readFileSync(dictPath, 'utf-8'));
const draft: DraftEntry[] = JSON.parse(readFileSync(draftPath, 'utf-8'));

const newEntries: DictEntry[] = draft.map(({ flags, ...entry }) => entry);

const merged: DictEntry[] = [...existing, ...newEntries];

const seen = new Set<string>();
const duplicates = merged.filter((e) => (seen.has(e.term_id) ? true : (seen.add(e.term_id), false)));
if (duplicates.length > 0) {
  console.error(`term_id conflict, nothing written: ${duplicates.map((e) => e.term_id).join(', ')}`);
  process.exit(1);
}

writeFileSync(dictPath, JSON.stringify(merged, null, 2) + '\n');
console.log(`Merged ${newEntries.length} entr(y/ies) into ${dictPath} (had ${existing.length}, now ${merged.length} total)`);
