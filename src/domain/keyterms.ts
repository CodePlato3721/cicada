import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { GAMES } from './games.js';

// STT 识别关键词增强（目前只有 Deepgram 的 keyterm prompting 用得上，见
// adapter/out/deepgram/stt.ts）用的词表——跟 domain/terminology.ts 那套翻译用的
// 术语库是两个独立的东西，故意不复用同一份数据：
// - terminology/<game>.json 要维护"语言无关 term_id → 各语言译法"的映射，服务翻译环节；
// - keyterms/<game>.json 只服务 STT 识别这一件事，只需要"源语言下这个词实际念起来/
//   写出来是什么样"，不需要目标语言译法、不需要 term_id、结构比术语库简单得多。
// 一个游戏一个文件，src/domain/keyterms/<game_id>.json，内容是一个字符串数组。
// games.js 声明了某个 game_id 但对应文件不存在，启动时直接报错（跟 terminology.js
// 同一个模式，不允许静默失效）。
//
// 挑词优先级（维护这份文件时的人工判断标准，不是代码校验的规则）：优先挑英雄名/
// 活动名这类专有名词——这类词通用语言模型见得少，最容易被判定为"不合理"整个吞掉或
// 纠正成常见字（实测复现过："打野"被识别成孤立的"也"，"打"字直接消失）。资源/建筑
// 这类常规词通用语言模型本来就认得，加不加关键词收益不大，优先级排后面。
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadKeytermFiles(): Map<string, string[]> {
  const byGame = new Map<string, string[]>();
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

// 取某个游戏词表里排在前面的 N 个——词表本身按重要性人工排序（维护时把更值得优先
// 保证识别准确率的词放前面），截断策略故意选"按文件顺序取前 N 个"，不在运行时做
// 任何重要性打分/排序，最简单、行为可预测。
// gameId 缺失或没有对应词表（理论上不会发生，见 loadKeytermFiles 的启动期校验）都
// 返回空数组，调用方（voice-listener.js）不需要额外判空。
export function getKeyterms(gameId: string | undefined, limit: number = DEFAULT_KEYTERM_LIMIT): string[] {
  if (!gameId) return [];
  const terms = KEYTERMS_BY_GAME.get(gameId);
  if (!terms) return [];
  return terms.slice(0, limit);
}
