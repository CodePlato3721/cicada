import type { VoiceConnection } from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import type { Gender } from '../domain/pitch.js';
import { resolveTtsProvider } from './ports/tts.js';
import { createLogger } from '../adapter/out/logger.js';

const logger = createLogger('session');

// 一个说话人在运行期积累的状态。vad/opusStream/decoder/forceEndSpeech 这些是
// adapter/in/voice-listener.js（还没转 TS，见 TASK-05）构造并挂上去的 Discord/VAD
// 相关字段，application 层不需要知道它们的具体类型，只关心自己会读写的那几个字段。
export interface SpeakerState {
  label?: string;
  gender?: Gender;
  lastTranscript?: string;
  voicesByProviderLang?: Record<string, string>;
  [key: string]: unknown;
}

// guildId -> { connection, voiceChannel, speakers: Map<userId, speakerState>, sourceLang, targetLang, ttsProvider, game }
// 这是整个应用运行期最接近"Model"的东西——不持久化，只在进程存活期间记录
// "现在都在监听谁、每个人的源语言/上一句识别结果是什么、翻译成什么语言、当前用哪个游戏的黑话词典"。
// 注意：这里只放业务状态，不放 Discord 事件监听器引用之类的 adapter 细节
// （那些留在 adapter/in/voice-listener.js 自己的作用域里）——voiceChannel 是个例外，
// 留着是因为 pipeline.js 需要它在自动检测到源语言时，往这个语音频道自带的文字聊天里
// 发一条通知（见 handleSegment），没有别的地方能拿到这个引用。
export interface Session {
  connection: VoiceConnection;
  voiceChannel: VoiceBasedChannel;
  speakers: Map<string, SpeakerState>;
  speakerSeq: number;
  // 播放顺序用的序号——每个人说的每一句话，在 VAD 判定"这句说完了"的那一刻（不是
  // "处理完了"的那一刻）按这个计数器分配一个严格递增的号码，代表真实的说话先后顺序。
  // STT/翻译是并发跑的，处理快的句子可能比处理慢的句子先返回，播放队列
  // （adapter/out/playback-queue.js）靠这个号码重排，不是按"谁先处理完就先播谁"。
  // 从 0 开始，playback-queue.js 那边的 nextSequence 也约定从 0 开始，两边靠这个
  // 约定对齐，不是这里能校验的。
  playbackSeq: number;
  // sourceLang/targetLang 都故意不给默认值——不设置的话是 undefined，pipeline.js
  // 的 handleSegment 检测到任意一个是假值就直接跳过翻译，播报一条提示让用户
  // /config source:<语言> target:<语言>（或分别用 /lang source:/target: 设置）。
  // sourceLang 曾经有"没手动设置就靠 STT 自动检测结果锁定"的兜底，已经整个移除——
  // 实测极短音频的语种检测准确度太低，不值得留着当默认路径（历史细节见 CLAUDE.md）。
  // 现在两者地位完全对称：都没有默认值，都没有兜底，都必须显式设置一次。这是刻意的
  // 产品决定：默认悄悄用某个语言，用户可能压根没注意到、也不是他们想要的。
  sourceLang: string | undefined;
  targetLang: string | undefined;
  // 跟 targetLang 联动，不单独设置——见下面 setTargetLang。目标语言没设置之前，
  // ttsProvider 也是 undefined。
  ttsProvider: string | undefined;
  // 默认用 games.js 里的第一个游戏（目前只有 whiteout 一个）；之后可以用 /game 实时改。
  // 等游戏列表真的涨到两个以上，这个"默认选第一个"可能就不够用了，到时候再改成强制要求选。
  game: string | undefined;
}

const sessions = new Map<string, Session>();

export function createSession(guildId: string, connection: VoiceConnection, voiceChannel: VoiceBasedChannel): Session {
  const session: Session = {
    connection,
    voiceChannel,
    speakers: new Map(),
    speakerSeq: 0,
    playbackSeq: 0,
    sourceLang: undefined,
    targetLang: undefined,
    ttsProvider: undefined,
    game: undefined,
  };
  sessions.set(guildId, session);
  return session;
}

export function getSession(guildId: string): Session | undefined {
  return sessions.get(guildId);
}

export function deleteSession(guildId: string): void {
  sessions.delete(guildId);
}

// 返回 false 表示这个 guild 现在没在监听（还没 /join）。调用来源：/config source:<语言>
// 或 /lang source:<语言> 手动设置——lang 由命令的 addChoices 收窄过（zh/en/ko/ar 之一）。
// 曾经还有 pipeline.js 自动检测锁定这条来源（STT 返回的 detected_language），已移除
// （见上面 Session.sourceLang 的注释），现在只有手动设置这一条路径。
export function setSourceLang(guildId: string, lang: string): boolean {
  const session = sessions.get(guildId);
  if (!session) return false;

  session.sourceLang = lang;
  logger.info({ guildId, sourceLang: lang }, `guild ${guildId} source language set to: ${lang}`);
  return true;
}

// 目标语言变化的同时联动更新 ttsProvider——这两个字段必须保持同步，不能分开设置
// （不然会出现 targetLang 已经改了、但 ttsProvider 还是旧供应商这种不一致状态）。
// 一个目标语言如果不在 TTS_PROVIDER_BY_LANG 里，resolveTtsProvider 返回 undefined，
// ttsProvider 也就是 undefined——pipeline.js 靠这个判断"这个目标语言没法出声音，
// 只有译文文字"。
export function setTargetLang(guildId: string, lang: string): boolean {
  const session = sessions.get(guildId);
  if (!session) return false;

  session.targetLang = lang;
  session.ttsProvider = resolveTtsProvider(lang);
  logger.info(
    { guildId, targetLang: lang, ttsProvider: session.ttsProvider ?? null },
    `guild ${guildId} target language set to: ${lang}, TTS provider: ${session.ttsProvider ?? '(none — this language has no voice, translated text only)'}`,
  );
  return true;
}

// 返回 false 表示这个 guild 现在没在监听（还没 /join）。gameId 由 /game 的子命令名给出，
// 不做合法性校验——data.js 里 addSubcommand 已经把选项收窄成 games.js 列表里的值了，
// Discord 不允许客户端传别的字符串上来。
export function setGame(guildId: string, gameId: string): boolean {
  const session = sessions.get(guildId);
  if (!session) return false;

  session.game = gameId;
  logger.info({ guildId, game: gameId }, `guild ${guildId} game set to: ${gameId}`);
  return true;
}

// /reset 用——把 source/target 语言、TTS 供应商、游戏选择都恢复成刚 /join 时的初始
// 状态（照抄 createSession 里的初始值，两处保持一致）。只清"设置"这一类字段，
// 不动 connection/voiceChannel/speakers——已经在监听的人、已经分配好的性别/音色
// 这些运行期状态不受影响，重新说话时会用回各自现有的音色，不会重新判性别。
export function resetSessionSettings(guildId: string): boolean {
  const session = sessions.get(guildId);
  if (!session) return false;

  session.sourceLang = undefined;
  session.targetLang = undefined;
  session.ttsProvider = undefined;
  session.game = undefined;
  logger.info({ guildId }, `guild ${guildId} settings reset (source/target language, TTS provider, game selection back to initial state)`);
  return true;
}

// 除了登记进 speakers Map，顺带给这个人分配一个"发言人N"标签——按这场会话里
// 第几个开口的人编号，纯粹为了日志和音色分配时可读，不代表任何持久身份，
// 每次 /join 重新开始都会从 1 重新编。
export function addSpeaker(guildId: string, userId: string, speakerState: SpeakerState): void {
  const session = sessions.get(guildId);
  if (!session) return;

  session.speakerSeq += 1;
  speakerState.label = `Speaker${session.speakerSeq}`;
  session.speakers.set(userId, speakerState);
}

// 分配下一个播放顺序号——必须在 voice-listener.js 里 VAD 刚判定"这句话说完了"的那一刻
// 同步调用（不能等 handleSegment 异步处理完再分配，那样分配到的顺序就是"处理完的顺序"
// 而不是"说话的顺序"，起不到重排的作用）。guild 不存在（还没 /join）返回 null。
export function nextPlaybackSequence(guildId: string): number | null {
  const session = sessions.get(guildId);
  if (!session) return null;

  const sequence = session.playbackSeq;
  session.playbackSeq += 1;
  return sequence;
}

export function getSpeaker(guildId: string, userId: string): SpeakerState | undefined {
  return sessions.get(guildId)?.speakers.get(userId);
}

export function hasSpeaker(guildId: string, userId: string): boolean {
  return sessions.get(guildId)?.speakers.has(userId) ?? false;
}

export function listSpeakers(guildId: string): IterableIterator<SpeakerState> | [] {
  return sessions.get(guildId)?.speakers.values() ?? [];
}
