import { GAMES } from '../domain/games.js';

// guildId -> { connection, speakers: Map<userId, speakerState>, sourceLang, targetLang, game }
// 这是整个应用运行期最接近"Model"的东西——不持久化，只在进程存活期间记录
// "现在都在监听谁、每个人的源语言/上一句识别结果是什么、翻译成什么语言、当前用哪个游戏的黑话词典"。
// 注意：这里只放业务状态，不放 Discord 事件监听器引用之类的 adapter 细节
// （那些留在 adapter/in/voice-listener.js 自己的作用域里）。
const sessions = new Map();

// 目前只支持中文/英文，系统默认源语言中文、目标语言英文，可以用 /lang source:<语言>
// target:<语言> 分别改（两个参数都可选，只传一个就只改那一个，另一个不动）。
const DEFAULT_SOURCE_LANG = 'zh';
const DEFAULT_TARGET_LANG = 'en';

export function createSession(guildId, connection) {
  const session = {
    connection,
    speakers: new Map(),
    speakerSeq: 0,
    // 默认读 .env 的 SOURCE_LANG/TRANSLATE_TARGET_LANG，没配就用上面的默认值；
    // 之后可以用 /lang 命令实时改，不用重启 bot。
    sourceLang: process.env.SOURCE_LANG || DEFAULT_SOURCE_LANG,
    targetLang: process.env.TRANSLATE_TARGET_LANG || DEFAULT_TARGET_LANG,
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

// 返回 false 表示这个 guild 现在没在监听（还没 /join）。lang 由 /lang 命令的 addChoices
// 收窄过，目前只会是 'zh'/'en'。
export function setSourceLang(guildId, lang) {
  const session = sessions.get(guildId);
  if (!session) return false;

  session.sourceLang = lang;
  console.log(`[session] guild ${guildId} 源语言设为：${lang}`);
  return true;
}

export function setTargetLang(guildId, lang) {
  const session = sessions.get(guildId);
  if (!session) return false;

  session.targetLang = lang;
  console.log(`[session] guild ${guildId} 目标语言设为：${lang}`);
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
