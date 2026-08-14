// 用法：node scripts/merge-terms.js heroes
//
// 把人工审核过的 scripts/drafts/<source>.draft.json 追加进正式词典
// src/domain/terminology/<game>.json——只追加，不改动已有条目。审核方式就是
// 直接编辑 draft 文件本身（删掉不要的条目、改掉 flags 标出来的可疑内容），
// 这个脚本不做任何"要不要"的判断，纯粹是把审核完的文件合并进去。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getSource } from './wiki-sources.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sourceId = process.argv[2];
if (!sourceId) {
  console.error('用法：node scripts/merge-terms.js <source id>');
  process.exit(1);
}

const source = getSource(sourceId);
const draftPath = path.join(__dirname, `drafts/${source.id}.draft.json`);
if (!existsSync(draftPath)) {
  console.error(`找不到 draft 文件：${draftPath}，先跑 node scripts/scrape-terms.js ${source.id}`);
  process.exit(1);
}

const dictPath = path.join(__dirname, `../src/domain/terminology/${source.game}.json`);
const existing = JSON.parse(readFileSync(dictPath, 'utf-8'));
const draft = JSON.parse(readFileSync(draftPath, 'utf-8'));

// draft 里的 flags 字段只是给人看的审核提示，合并进正式词典之前去掉，不留在数据里。
const newEntries = draft.map(({ flags, ...entry }) => entry);

const merged = [...existing, ...newEntries];

// term_id 理论上不该撞车（scrape-terms.js 按 en 名字去重过），但换名字/手改过
// draft 文件之后有可能撞上，撞了就直接报错、不写文件，好过悄悄产生一份坏词典。
const seen = new Set();
const duplicates = merged.filter((e) => (seen.has(e.term_id) ? true : (seen.add(e.term_id), false)));
if (duplicates.length > 0) {
  console.error(`term_id 冲突，没有写入：${duplicates.map((e) => e.term_id).join(', ')}`);
  process.exit(1);
}

writeFileSync(dictPath, JSON.stringify(merged, null, 2) + '\n');
console.log(`已合并 ${newEntries.length} 条进 ${dictPath}（原有 ${existing.length} 条，现在共 ${merged.length} 条）`);
