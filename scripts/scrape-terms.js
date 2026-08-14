// 用法：
//   node scripts/scrape-terms.js heroes
//   node scripts/scrape-terms.js --all
//
// 抓完不会直接改 src/domain/terminology/<game>.json，写到 scripts/drafts/<source>.draft.json
// 里等人工审核（删掉不要的条目、修正 flags 标出来的可疑条目），审核完用
// `node scripts/merge-terms.js <source>` 合并进正式词典。为什么要这道人工审核，
// 见 CLAUDE.md「游戏黑话/专有名词术语库」和这个功能的实现规划。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SOURCES, getSource } from './wiki-sources.js';
import {
  fetchListPage,
  verifyNoHiddenPagination,
  resolveZhName,
  cleanText,
  toTermId,
  pool,
} from './lib/wiki-scraper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRAFTS_DIR = path.join(__dirname, 'drafts');

// 常见英文人名的粗略名单——命中就标 common-name 风险，提醒"这个词条可能跟日常
// 对话里的真人名字撞车"（英雄那批数据里 Charlie/Mia/Molly/Patrick/Wayne/Gordon
// 这几个就是这么被发现的）。不追求完整，宁可漏标也不做成什么复杂的姓名库。
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

const UNUSUAL_PUNCTUATION = /[–—&]/; // 破折号/&，不太可能出现在语音转写结果里

function flagRisks(entry) {
  const flags = [];
  const firstWord = entry.translations.en.split(/\s+/)[0]?.toLowerCase();
  if (COMMON_NAMES.has(firstWord)) flags.push('common-name');
  if (UNUSUAL_PUNCTUATION.test(entry.translations.en) || UNUSUAL_PUNCTUATION.test(entry.translations.zh)) {
    flags.push('unusual-punctuation');
  }
  return flags;
}

function loadExistingEnNames(game) {
  const filePath = path.join(__dirname, `../src/domain/terminology/${game}.json`);
  if (!existsSync(filePath)) return new Set();
  const entries = JSON.parse(readFileSync(filePath, 'utf-8'));
  return new Set(
    entries.flatMap((entry) => {
      const en = entry.translations?.en;
      const forms = Array.isArray(en) ? en : [en];
      return forms.filter(Boolean).map((s) => s.toLowerCase());
    }),
  );
}

async function scrapeSource(sourceId) {
  const source = getSource(sourceId);
  console.log(`\n=== 抓取分类：${source.id}（${source.listUrl}） ===`);

  const cards = await fetchListPage(source.listUrl);
  console.log(`列表页找到 ${cards.length} 条`);

  const paginationCheck = await verifyNoHiddenPagination(source.listUrl, cards.map((c) => c.slug));
  if (paginationCheck.checked && !paginationCheck.consistent) {
    console.warn(
      `⚠ 警告：page/2/ 的内容跟第一页不一样（第二页有 ${paginationCheck.page2Count} 条）——这个分类可能真的有分页，` +
        `当前脚本只处理了第一页，需要人工确认要不要扩展抓取逻辑。`,
    );
  }

  const existingEnNames = loadExistingEnNames(source.game);

  const resolved = await pool(cards, 5, async ({ slug, name }) => {
    const enDetailUrl = `${source.listUrl}${slug}/`;
    try {
      const zhName = await resolveZhName(enDetailUrl);
      return { slug, en: cleanText(name), zh: zhName ? cleanText(zhName) : null };
    } catch (e) {
      return { slug, en: cleanText(name), zh: null, error: String(e) };
    }
  });

  const unpaired = resolved.filter((r) => !r.zh);
  const paired = resolved.filter((r) => r.zh);

  const draft = [];
  let skippedExisting = 0;
  for (const { en, zh } of paired) {
    if (existingEnNames.has(en.toLowerCase())) {
      skippedExisting += 1;
      continue;
    }
    const entry = { term_id: toTermId(source.idPrefix, en), translations: { en, zh } };
    const flags = flagRisks(entry);
    draft.push(flags.length > 0 ? { ...entry, flags } : entry);
  }

  mkdirSync(DRAFTS_DIR, { recursive: true });
  const draftPath = path.join(DRAFTS_DIR, `${source.id}.draft.json`);
  writeFileSync(draftPath, JSON.stringify(draft, null, 2) + '\n');

  const flaggedCount = draft.filter((e) => e.flags).length;
  console.log(`新增: ${draft.length} 条（其中 ${flaggedCount} 条有风险标记）`);
  console.log(`已存在(跳过): ${skippedExisting} 条`);
  console.log(`未配对(没有中文页面): ${unpaired.length} 个${unpaired.length ? '：' + unpaired.map((u) => u.en).join('、') : ''}`);
  if (draft.length > 0) {
    console.log(`\n已写入 ${draftPath}，人工审核（删掉不要的条目/修正 flags 标出来的可疑条目）之后运行：`);
    console.log(`  node scripts/merge-terms.js ${source.id}`);
  } else {
    console.log('没有新条目，不需要审核。');
  }
}

const args = process.argv.slice(2);
const targets = args.includes('--all') ? SOURCES.map((s) => s.id) : args;

if (targets.length === 0) {
  console.error(`用法：node scripts/scrape-terms.js <${SOURCES.map((s) => s.id).join('|')}> 或 --all`);
  process.exit(1);
}

for (const id of targets) {
  await scrapeSource(id);
}
