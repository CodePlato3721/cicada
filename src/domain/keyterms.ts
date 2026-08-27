import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { GAMES } from './games.js';
import { toBaseLang } from './language.js';

// STT 识别关键词增强（目前只有 Deepgram 的 keyterm prompting 用得上，见
// adapter/out/deepgram/stt.ts）用的词表——跟 domain/terminology.ts 那套翻译用的
// 术语库是两个独立的东西，故意不复用同一份数据：
// - terminology/<game>.json 要维护"语言无关 term_id → 各语言译法"的映射，服务翻译环节；
// - keyterms/<game>.json 只服务 STT 识别这一件事，只需要"这门源语言下这个词实际念起来/
//   写出来是什么样"，不需要 term_id、不需要跨语言对齐，结构比术语库简单得多。
//
// 按"源语言 → 词表"两层分组（Record<lang, string[]>），不是单一扁平数组——最早只支持
// 中文时是扁平数组，调用方（voice-listener.js）用 `sourceLang === 'zh'` 手动判断要不要
// 传关键词，加一种源语言的关键词支持就要在调用方多写一个条件分支，不可扩展。现在跟
// terminology.js 的按语言分组同一个思路：一个游戏一个文件，文件内部按 SUPPORTED_SOURCE_LANGS
// 里的语言码分组，不要求每个游戏在每种源语言下都必须有词表——缺某个语言的条目就是这门
// 语言暂时没有专门维护，getKeyterms 会回退到 'en' 词表（见下面 getKeyterms 内部的说明），
// 连 'en' 都没有才真正返回空数组，不报错。
//
// 一个游戏一个文件，src/domain/keyterms/<game_id>.json。games.js 声明了某个 game_id
// 但对应文件不存在，启动时直接报错（跟 terminology.js 同一个模式，不允许静默失效）。
//
// 挑词优先级（维护这份文件时的人工判断标准，不是代码校验的规则）：优先挑英雄名/
// 活动名这类专有名词——这类词通用语言模型见得少，最容易被判定为"不合理"整个吞掉或
// 纠正成常见字（实测复现过：中文场景下"打野"被识别成孤立的"也"，"打"字直接消失）。
// 资源/建筑这类常规词通用语言模型本来就认得，加不加关键词收益不大，优先级排后面。
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type KeytermsByLang = Record<string, string[] | undefined>;

function loadKeytermFiles(): Map<string, KeytermsByLang> {
  const byGame = new Map<string, KeytermsByLang>();
  for (const game of GAMES) {
    const filePath = path.join(__dirname, `keyterms/${game.id}.json`);
    if (!existsSync(filePath)) {
      throw new Error(`games.js declares game "${game.id}" but its keyterm file is missing: ${filePath}`);
    }
    byGame.set(game.id, JSON.parse(readFileSync(filePath, 'utf-8')));
  }
  return byGame;
}

const KEYTERMS_BY_GAME = loadKeytermFiles();

// Deepgram keyterm prompting 官方硬上限是 500 token（约 100 个词），超了整个请求直接
// 报错；官方建议实际控制在 20-50 个以内，塞太多反而会干扰正常识别（"force-fitting
// risk increases as keyterm count grows"，见 https://developers.deepgram.com/docs/keyterm）。
// 默认给 50（官方建议区间的上沿），可以用环境变量调，不写死——跟 VAD_SILENCE_MS 这类
// 阈值同一个思路（见 CLAUDE.md「VAD 切句注意事项」），不是所有阈值都要集中放
// config.ts，纯算法/调优类阈值就近放在实际用到它的 domain 文件里（streaming-vad.ts
// 的 VAD_* 系列也是这么处理的）。
const DEFAULT_KEYTERM_LIMIT = Number(process.env.STT_KEYTERM_LIMIT) || 50;

// 取某个"游戏 + 源语言"组合下排在前面的 N 个词——词表本身按重要性人工排序（维护时
// 把更值得优先保证识别准确率的词放前面），截断策略故意选"按文件顺序取前 N 个"，
// 不在运行时做任何重要性打分/排序，最简单、行为可预测。
// gameId/lang 任一缺失都返回空数组，调用方（voice-listener.js）不需要额外判空，也不需要
// 像以前那样自己判断"这门语言支不支持关键词"再决定要不要调用。
export function getKeyterms(gameId: string | undefined, lang: string | undefined, limit: number = DEFAULT_KEYTERM_LIMIT): string[] {
  // lang（调用方传的通常是 session.sourceLang）2026-08-26 起是具体 locale（如
  // 'zh-TW'），词典文件按语言家族分组、不分地区，查表前先还原成基础码（见
  // domain/language.js）。
  const baseLang = toBaseLang(lang);
  if (!gameId || !baseLang) return [];

  const byLang = KEYTERMS_BY_GAME.get(gameId);
  // source 语言现在有 79 个 locale（见 ports/stt.js 的 SUPPORTED_SOURCE_LANGS），对应
  // 几十种语言家族，不可能每种都手工整理一份 wiki 来源的词表——大多数语言根本没有这类
  // 游戏的本地化资料。这些语言的玩家提到英雄名/活动名这类专有名词时，实际上普遍是直接
  // 说英文原名（很多地区本来就没有官方本地化译名可用），所以没有专门维护词表的语言统一
  // 回退到 'en' 词表，而不是返回空数组——空数组等于放弃这些语言的关键词增强，'en' 兜底
  // 至少覆盖了"很可能确实是这么说的"这个大概率情况。'en' 本身也没整理（这个游戏还完全
  // 没有关键词数据）才真正返回空数组。某个语言想明确表示"不要 en 兜底"，在文件里显式写
  // `"xx": []` 即可——空数组本身是有值的（不是 undefined），不会触发下面的回退。
  const terms = byLang?.[baseLang] ?? (baseLang === 'en' ? undefined : byLang?.en);
  if (!terms) return [];
  return terms.slice(0, limit);
}
