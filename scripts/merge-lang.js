// 用法：node scripts/merge-lang.js heroes ko ar
//
// 把人工审核过的 scripts/drafts/<source>.<lang1>-<lang2>.patch.json 合并进正式词典
// src/domain/terminology/<game>.json——这是"给已有 term_id 加字段"，不是追加新词条，
// 跟 merge-terms.js（只追加、不改动已有条目）刚好相反，不能混用。
// 审核方式：直接编辑 patch 文件本身（删掉不要的字段/条目、修正翻译）。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getSource } from './wiki-sources.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const sourceId = args[0];
const langs = args.slice(1);
if (!sourceId || langs.length === 0) {
  console.error('用法：node scripts/merge-lang.js <source id> <语言码...>');
  process.exit(1);
}

const source = getSource(sourceId);
const patchPath = path.join(__dirname, `drafts/${source.id}.${langs.join('-')}.patch.json`);
if (!existsSync(patchPath)) {
  console.error(`找不到 patch 文件：${patchPath}，先跑 node scripts/scrape-lang.js ${source.id} ${langs.join(' ')}`);
  process.exit(1);
}

const dictPath = path.join(__dirname, `../src/domain/terminology/${source.game}.json`);
const dict = JSON.parse(readFileSync(dictPath, 'utf-8'));
const patch = JSON.parse(readFileSync(patchPath, 'utf-8'));

const byTermId = new Map(dict.map((e) => [e.term_id, e]));

let updated = 0;
let notFound = 0;
for (const p of patch) {
  const entry = byTermId.get(p.term_id);
  if (!entry) {
    console.warn(`词典里找不到 term_id "${p.term_id}"，跳过（词典可能在生成 patch 之后又改过）`);
    notFound += 1;
    continue;
  }
  for (const lang of langs) {
    if (p[lang]) entry.translations[lang] = p[lang];
  }
  updated += 1;
}

writeFileSync(dictPath, JSON.stringify(dict, null, 2) + '\n');
console.log(`已给 ${updated} 条词条补上 ${langs.join('/')} 字段（${dictPath}）`);
if (notFound > 0) console.log(`${notFound} 条在词典里找不到对应 term_id，已跳过`);
