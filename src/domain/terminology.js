import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import OpenCC from 'opencc-js';
import { GAMES } from './games.js';

// STT 就算传了 language=zh-TW，也不保证每次都吐繁体——偶尔会混进简体字，跟词典
// （繁体来源）字符串对不上，术语检测会静默漏掉。这里把中文源文本先正规化成繁体
// 再匹配，不管 STT 这次给的是简体还是繁体都能对上；不影响发给 LLM 翻译的内容本身
// （简繁体对 LLM 翻译理解没有影响），只是匹配前的一步预处理。
const toTraditional = OpenCC.Converter({ from: 'cn', to: 'tw' });

// 游戏黑话/专有名词术语库：语言无关的中心 term_id，下面挂各语言译法（TBX 思路），
// 不维护语言两两之间的映射表。设计背景见 CLAUDE.md「游戏黑话/专有名词术语库」一节。
//
// 一个游戏一个词典文件：src/domain/terminology/<game_id>.json，文件名本身就是
// game_id，词条内部不用再重复标 game 字段——避免"文件放错目录"和"字段里写的游戏
// 不一致"这两份信息不同步的可能。games.js 是游戏列表的唯一权威来源，这里照着它
// 声明的每个游戏去读对应文件；games.js 里加了游戏但没建对应词典文件，直接在启动时
// 报错炸出来，而不是运行时悄悄词典失效（跟 config.js 里 required() 的思路一致）。
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadDictionaries() {
  const byGame = new Map(); // gameId -> entries[]
  for (const game of GAMES) {
    const filePath = path.join(__dirname, `terminology/${game.id}.json`);
    if (!existsSync(filePath)) {
      throw new Error(`games.js 声明了游戏 "${game.id}"，但找不到对应词典文件：${filePath}`);
    }
    byGame.set(game.id, JSON.parse(readFileSync(filePath, 'utf-8')));
  }
  return byGame;
}

// 中日韩没有空格分词，JS 正则的 \b 是按 \w（只认拉丁字母/数字/下划线）判断边界的，
// 对 CJK 字符完全不生效，加了反而匹配不到——所以这些语言的正则不加 \b。
// 其他语言（空格分词）必须加 \b，否则 "flank" 会命中 "Frankly" 中间那一截。
const CJK_LANGS = new Set(['zh', 'ja', 'ko']);

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// translations[lang] 可以是一个字符串，也可以是一个数组——数组时第一项是"官方/规范
// 译法"（用于当这门语言是目标语言时替换成什么），其余项是已知的同音/异写变体（比如
// STT 把 "Molly" 识别成"莫莉"而不是官方译名"茉莉"），仅用于扩大匹配面，不会被当成
// 输出结果。这批变体是实际使用中人工修正积累起来的（见 CLAUDE.md 词典数据来源），
// 不是一次性能想全的，遇到新的 STT 误识别就往数组里加一条。
function surfaceForms(value) {
  return Array.isArray(value) ? value : [value];
}

function canonicalForm(value) {
  return Array.isArray(value) ? value[0] : value;
}

// 每个游戏各自的词条按语言分组编译：同一个英文词在不同游戏里可能是完全不同的黑话
// 译法（见 CLAUDE.md），不能假设一个词全局只有一种正确翻译。每种"游戏+语言"组合
// 各编一条正则，一次扫描同时检测该组合下所有词条。POC 词典规模只有几十条量级，用
// "最长优先排序的 alternation + 全局 exec"就等价于 Aho-Corasick 的效果（词典涨到
// 几百上千条、实测这个方案变慢了，再考虑换专门的库）——排序保证同一起点位置优先
// 匹配更长的词（比如 "outflank" 优先整体匹配，不会先截出 "flank"）；exec 循环天然
// 按顺序消费文本、不会产出互相重叠的匹配，同时满足"最长匹配优先、不重叠"。
const automatons = buildAutomatons(loadDictionaries());

function buildAutomatons(dictionariesByGame) {
  const result = new Map(); // game -> Map<lang, { regex, lookup }>
  for (const [game, entries] of dictionariesByGame) {
    const byLang = new Map(); // lang -> [{ surface, entry }]
    for (const entry of entries) {
      for (const [lang, value] of Object.entries(entry.translations)) {
        if (!value) continue;
        if (!byLang.has(lang)) byLang.set(lang, []);
        for (const surface of surfaceForms(value)) {
          byLang.get(lang).push({ surface, entry });
        }
      }
    }

    const langMap = new Map();
    for (const [lang, items] of byLang) {
      const sorted = [...items].sort((a, b) => b.surface.length - a.surface.length);
      const alternation = sorted.map((item) => escapeRegex(item.surface)).join('|');
      const boundary = CJK_LANGS.has(lang) ? '' : '\\b';
      const regex = new RegExp(`${boundary}(?:${alternation})${boundary}`, 'gi');
      const lookup = new Map(sorted.map((item) => [item.surface.toLowerCase(), item.entry]));
      langMap.set(lang, { regex, lookup });
    }
    result.set(game, langMap);
  }
  return result;
}

// text: 某个说话人这一段的原文。sourceLang: 这段话的源语言（未知就传 undefined，
// 直接跳过检测，不强行猜）。targetLang: 要翻译成的目标语言。game: 当前 session 选的
// 游戏（/game 设置，见 session.js），决定用哪本词典——不传或者词典里没有这个游戏的
// 条目就直接跳过检测。
// 返回 { text, hitCount }：text 是命中术语被替换成 <keep>目标语言译词</keep> 之后的文本，
// 没命中的部分原样保留；hitCount 是命中并成功替换的词条数，0 表示这段话没有可强制的术语，
// 调用方可以据此决定要不要往 prompt 里加 <keep> 的说明。
export function applyTerminology(text, sourceLang, targetLang, game) {
  if (!text || !sourceLang || !game) return { text, hitCount: 0 };

  const automaton = automatons.get(game)?.get(sourceLang);
  if (!automaton) return { text, hitCount: 0 };

  // 中文先正规化成繁体再匹配（词典数据是繁体来源），不管 STT 这次吐的是简体还是
  // 繁体都能对上；后面不再用调用方传进来的原始 text，全程用正规化后的版本。
  if (sourceLang === 'zh') text = toTraditional(text);

  const { regex, lookup } = automaton;
  regex.lastIndex = 0; // 正则是全局(g)、有状态的，跨调用复用前必须重置，否则从上次扫到的位置继续扫

  let hitCount = 0;
  let out = '';
  let lastEnd = 0;
  let match;
  while ((match = regex.exec(text))) {
    const matched = match[0];
    const entry = lookup.get(matched.toLowerCase());
    const targetWord = sourceLang === targetLang ? undefined : canonicalForm(entry?.translations?.[targetLang]);

    out += text.slice(lastEnd, match.index);
    if (targetWord) {
      out += `<keep>${targetWord}</keep>`;
      hitCount += 1;
    } else {
      // 这个词条在目标语言下没有登记译法（或者源=目标语言本来就不用翻），原样保留，
      // 交给 LLM 按通用翻译逻辑处理，不强行包标签。
      out += matched;
    }
    lastEnd = match.index + matched.length;
  }
  out += text.slice(lastEnd);

  return { text: out, hitCount };
}

// 清理 <keep>/</keep> 标签本身，得到最终可用的译文。纯字符串处理，不涉及翻译逻辑。
export function stripKeepTags(text) {
  return text.replace(/<\/?keep>/g, '');
}
