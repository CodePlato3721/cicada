// guildId -> { connection, speakers: Map<userId, speakerState>, sourceLang }
// 这是整个应用运行期最接近"Model"的东西——不持久化，只在进程存活期间记录
// "现在都在监听谁、每个人的源语言/上一句识别结果是什么"。
// 注意：这里只放业务状态，不放 Discord 事件监听器引用之类的 adapter 细节
// （那些留在 adapter/in/voice-listener.js 自己的作用域里）。
const sessions = new Map();

export function createSession(guildId, connection) {
  const session = {
    connection,
    speakers: new Map(),
    speakerSeq: 0,
    // 默认读 .env 的 SOURCE_LANG，之后可以用 /source 命令实时改，不用重启 bot。
    sourceLang: process.env.SOURCE_LANG || undefined,
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

// lang 传 null/undefined 表示切回自动检测。返回 false 表示这个 guild 现在没在监听（还没 /join）。
export function setSourceLang(guildId, lang) {
  const session = sessions.get(guildId);
  if (!session) return false;

  session.sourceLang = lang || undefined;
  console.log(`[session] guild ${guildId} 源语言设为：${session.sourceLang ?? '自动检测'}`);
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
