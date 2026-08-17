// 用法：node scripts/merge-lang.js heroes ko ar
//
// 把人工审核过的 scripts/drafts/<source>.<lang1>-<lang2>.patch.json 合并进正式词典
// src/domain/terminology/<game>.json——这是"给已有 term_id 加字段"，不是追加新词条，
// 跟 merge-terms.js（只追加、不改动已有条目）刚好相反，不能混用。
// 审核方式：直接编辑 patch 文件本身（删掉不要的字段/条目、修正翻译）。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getSource } from './wiki-sources.js';

interface DictEntry {
  term_id: string;
  translations: Record<string, string | string[] | undefined>;
}

type LangPatch = { term_id: string } & Record<string, string | undefined>;

// 见 merge-terms.ts 顶部注释：编译产物跑在 dist/scripts/ 下，跟源码目录深度不一样，
// 锚定 process.cwd()（npm script 固定从项目根目录调用）比按 __dirname 手算相对
// 路径更稳。
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
