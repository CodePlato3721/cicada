import { GAMES } from '../domain/games.js';
import { resolveTtsProvider } from './ports/tts.js';

// guildId -> { connection, voiceChannel, speakers: Map<userId, speakerState>, sourceLang, targetLang, ttsProvider, game }
// 这是整个应用运行期最接近"Model"的东西——不持久化，只在进程存活期间记录
// "现在都在监听谁、每个人的源语言/上一句识别结果是什么、翻译成什么语言、当前用哪个游戏的黑话词典"。
// 注意：这里只放业务状态，不放 Discord 事件监听器引用之类的 adapter 细节
// （那些留在 adapter/in/voice-listener.js 自己的作用域里）——voiceChannel 是个例外，
// 留着是因为 pipeline.js 需要它在自动检测到源语言时，往这个语音频道自带的文字聊天里
// 发一条通知（见 handleSegment），没有别的地方能拿到这个引用。

const sessions = new Map();

export function createSession(guildId, connection, voiceChannel) {
  const session = {
    connection,
    voiceChannel,
    speakers: new Map(),
    speakerSeq: 0,
    // sourceLang/targetLang 都故意不给默认值——不设置的话是 undefined。
    // targetLang：pipeline.js 的 handleSegment 检测到是假值就直接跳过翻译，播报一条
    //   提示让用户先 /lang target:<语言>。
    // sourceLang：/lang source:<语言> 手动设置优先；没手动设置的话，交给 pipeline.js
    //   用第一句话的 STT 自动检测结果锁定（见 handleSegment 里的自动检测逻辑），检测
    //   结果直接写回这个字段，之后跟手动设置效果一样，不会每句话都重新检测。
    // 这是刻意的产品决定：默认悄悄用某个语言，用户可能压根没注意到、也不是他们想要的，
    // 不如强制显式设置一次（源语言退而求其次靠自动检测兜底，目标语言完全没有兜底）。
    sourceLang: undefined,
    targetLang: undefined,
    // 跟 targetLang 联动，不单独设置——见下面 setTargetLang。目标语言没设置之前，
    // ttsProvider 也是 undefined。
    ttsProvider: undefined,
    // 默认用 games.js 里的第一个游戏（目前只有 whiteout 一个）；之后可以用 /game 实时改。
    // 等游戏列表真的涨到两个以上，这个"默认选第一个"可能就不够用了，到时候再改成强制要求选。
    game: GAMES[0]?.id,
  };
  sessions.set(guildId, session);
  return session;
}

export function getSession(guildId) {
  return sessions.get(guildId);
}

export function deleteSession(guildId) {
  sessions.delete(guildId);
}

// 返回 false 表示这个 guild 现在没在监听（还没 /join）。两种调用来源：
// 1. /lang source:<语言> 手动设置——lang 由命令的 addChoices 收窄过（zh/en/ko/ar 之一）
// 2. pipeline.js 的自动检测逻辑——lang 是 Deepgram 返回的 detected_language，不受
//    addChoices 限制，理论上可能是任何 Deepgram 认识的语言代码
export function setSourceLang(guildId, lang) {
  const session = sessions.get(guildId);
  if (!session) return false;

  session.sourceLang = lang;
  console.log(`[session] guild ${guildId} 源语言设为：${lang}`);
  return true;
}

// 目标语言变化的同时联动更新 ttsProvider——这两个字段必须保持同步，不能分开设置
// （不然会出现 targetLang 已经改了、但 ttsProvider 还是旧供应商这种不一致状态）。
// 一个目标语言如果不在 TTS_PROVIDER_BY_LANG 里，resolveTtsProvider 返回 undefined，
// ttsProvider 也就是 undefined——pipeline.js 靠这个判断"这个目标语言没法出声音，
// 只有译文文字"。
export function setTargetLang(guildId, lang) {
  const session = sessions.get(guildId);
  if (!session) return false;

  session.targetLang = lang;
  session.ttsProvider = resolveTtsProvider(lang);
  console.log(
    `[session] guild ${guildId} 目标语言设为：${lang}，TTS 供应商：${session.ttsProvider ?? '（无——这个语言没法出声音，只有译文文字）'}`,
  );
  return true;
}

// 返回 false 表示这个 guild 现在没在监听（还没 /join）。gameId 由 /game 的子命令名给出，
// 不做合法性校验——data.js 里 addSubcommand 已经把选项收窄成 games.js 列表里的值了，
// Discord 不允许客户端传别的字符串上来。
export function setGame(guildId, gameId) {
  const session = sessions.get(guildId);
  if (!session) return false;

  session.game = gameId;
  console.log(`[session] guild ${guildId} 游戏设为：${gameId}`);
  return true;
}

// 除了登记进 speakers Map，顺带给这个人分配一个"发言人N"标签——按这场会话里
// 第几个开口的人编号，纯粹为了日志和音色分配时可读，不代表任何持久身份，
// 每次 /join 重新开始都会从 1 重新编。
export function addSpeaker(guildId, userId, speakerState) {
  const session = sessions.get(guildId);
  if (!session) return;

  session.speakerSeq += 1;
  speakerState.label = `发言人${session.speakerSeq}`;
  session.speakers.set(userId, speakerState);
}

export function getSpeaker(guildId, userId) {
  return sessions.get(guildId)?.speakers.get(userId);
}

export function hasSpeaker(guildId, userId) {
  return sessions.get(guildId)?.speakers.has(userId) ?? false;
}

export function listSpeakers(guildId) {
  return sessions.get(guildId)?.speakers.values() ?? [];
}
