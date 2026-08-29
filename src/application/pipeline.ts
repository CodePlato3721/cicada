import type { VoiceConnection } from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import { ttsWavToDiscordPcm } from '../domain/wav.js';
import { estimateGender } from '../domain/pitch.js';
import { applyTerminology, stripKeepTags } from '../domain/terminology.js';
import { lookupTranslationCache } from './translate-cache-lookup.js';
import { saveOutputRecording } from '../adapter/out/recordings.js';
import { setCachedTranslation } from '../adapter/out/redis/translate-cache.js';
import type { TranscribeResult } from './ports/stt.js';
import { translate } from './ports/translate.js';
import { synthesize } from './ports/tts.js';
import { enqueuePlayback, skipPlaybackSequence, checkBacklogWarning, BACKLOG_WARNING_THRESHOLD } from '../adapter/out/playback-queue.js';
import { getSession, listSpeakerEntries, saveSpeaker, type SpeakerState } from './session.js';
import { assignVoice } from './voice-assignment.js';
import { checkTranslateAllowed, recordExternalApiUsage } from './billing/billing-service.js';
import { createLogger } from '../adapter/out/logger.js';

const logger = createLogger('pipeline');

// 显式设置 TTS_VOICE 就强制所有人用同一个音色（调试/回退用）；不设置就默认按
// 每个说话人检测到的性别、当前 session.ttsProvider 分配音色（见 resolveSpeakerVoice）。
// 注意：多供应商场景下这个覆盖值只对"当前恰好路由到的那个供应商"有效——比如设成一个
// Deepgram 的音色名，目标语言换成 zh、路由去了 azure，这个覆盖值就是无效的音色名，
// 会在 synthesize 里报错。这是调试/回退功能本来的定位（单一供应商场景下用），
// 多供应商场景下用这个覆盖要自己确认当前目标语言实际会路由到哪个供应商。
const TTS_VOICE_OVERRIDE = process.env.TTS_VOICE || undefined;

// source/target 语言还没配置齐时发的固定文字提示——改用文字而不是语音播报：语音播报
// 依赖 TTS 供应商这条链路本身（会经过 synthesize/播放队列，任何一环出问题都可能又变成
// "静默失败、听不到声音也看不出哪里错了"，之前已经踩过一次这个坑），文字消息走
// voiceChannel.send 不依赖 TTS，链路更短、失败了控制台也看得到明确报错。
// 这里可以直接把命令语法写全（比如反引号包住的 /config source:<language> target:<language>）——
// 文字不用考虑"念出来怪不怪"这个语音场景才有的限制。
//
// source 曾经有"不设置就靠 STT 自动检测锁定"的兜底（第一句话检测、结果落进
// SUPPORTED_SOURCE_LANGS 白名单才锁定），已经整个删掉——实测极短音频的语种检测准确度
// 太低（比如 0.86 秒的"hello hello"被判成 cs/捷克语），不值得留着当默认路径。现在
// source 跟 target 地位对称：都没有默认值，都必须显式设置，`/config` 一条命令把两个
// 一起设完，是取代原来"必须先 /lang target:<language>"那条路径的新入口。
const CONFIG_NOT_SET_MESSAGE =
  "⚠️ I can't translate yet — set source and target language first with `/config source:<language> target:<language>`.";

async function sendConfigNotSetReminder(voiceChannel: VoiceBasedChannel): Promise<void> {
  await voiceChannel.send(CONFIG_NOT_SET_MESSAGE).catch((err: unknown) => logger.error({ err }, 'Failed to send config-not-set reminder'));
}

async function sendBillingBlockedReminder(voiceChannel: VoiceBasedChannel, message: string): Promise<void> {
  await voiceChannel.send(`⚠️ ${message}`).catch((err: unknown) => logger.error({ err }, 'Failed to send billing-blocked reminder'));
}

async function sendBillingWarningReminder(voiceChannel: VoiceBasedChannel, message: string): Promise<void> {
  await voiceChannel.send(`⚠️ ${message}`).catch((err: unknown) => logger.error({ err }, 'Failed to send billing-warning reminder'));
}

// 播放队列积压提醒：playback-queue.js 的 checkBacklogWarning 已经做了边沿检测（只在
// "这一波积压刚超过阈值"那一刻返回 true），这里不用再自己去重，直接发。措辞用了
// BACKLOG_WARNING_THRESHOLD 这个常量而不是硬编码"3"，阈值改了这条消息的文案会自动跟着变。
const BACKLOG_WARNING_MESSAGE =
  `🐢 Translation queue is backed up (more than ${BACKLOG_WARNING_THRESHOLD} lines waiting to play) — try speaking a little slower so translations can keep up.`;

async function sendBacklogWarningReminder(voiceChannel: VoiceBasedChannel): Promise<void> {
  await voiceChannel.send(BACKLOG_WARNING_MESSAGE).catch((err: unknown) => logger.error({ err }, 'Failed to send backlog-warning reminder'));
}

// 说话人第一次开口时判断性别，纯声学特征、跟 TTS 供应商无关，只需要判一次、
// 整场会话不变（不会因为目标语言/供应商切换而重新判断）。
function detectSpeakerGender(speakerState: SpeakerState, monoFloat32: Float32Array): void {
  if (speakerState.gender) return; // 已经判过，跳过

  const { gender, medianHz } = estimateGender(monoFloat32);
  speakerState.gender = gender;

  const pitchInfo = medianHz ? `pitch≈${medianHz.toFixed(0)}Hz` : 'volume too low/short to judge, picked randomly';
  logger.info(
    { speaker: speakerState.label, gender, medianHz: medianHz ?? null },
    `${speakerState.label} spoke for the first time, gender=${gender} (${pitchInfo})`,
  );
}

// 每个说话人在当前 guild target/ttsProvider 下固定一个音色。source/target 是 guild 级配置；
// target/ttsProvider 变化时 session.ts 会清掉所有 speaker.voice，下次播放再按新语言重新分配。
async function resolveSpeakerVoice(guildId: string, userId: string, speakerState: SpeakerState, provider: string, lang: string): Promise<string> {
  if (speakerState.voice) return speakerState.voice;

  const usedVoices = new Set(
    (await listSpeakerEntries(guildId))
      .filter(([speakerUserId]) => speakerUserId !== userId)
      .map(([, speaker]) => speaker)
      .map((speaker) => speaker.voice)
      .filter((voice): voice is string => Boolean(voice)),
  );
  const voice = assignVoice(speakerState.gender ?? 'unknown', usedVoices, provider, lang);
  speakerState.voice = voice;
  await saveSpeaker(guildId, userId, speakerState);
  logger.info(
    { speaker: speakerState.label, provider, lang, voice },
    `${speakerState.label} first use of ${provider}(${lang}) for playback, assigned voice: ${voice}`,
  );
  return voice;
}

// 一段完整语音（16kHz 单声道 Float32）→ STT → 翻译 → TTS → 播放。
// 这个函数是"发射后不管"地被调用的，不会阻塞上面继续采集下一句话。
// 这是这个项目里唯一的"用例"，所以叫 pipeline 而不是 xxxService——名字更贴近它实际做的事。
//
// sequence：这句话在整场会话里真实的说话顺序号，voice-listener.js 在 VAD 判定"这句话
// 说完了"的那一刻同步分配好、传进来的（不是这个函数自己生成的）。因为这个函数本身是
// 并发跑的，处理快的句子可能比处理慢的句子先跑到最后的播放这一步，如果播放顺序只看
// "谁先处理完"，会出现后说的话先播出来这种乱序（实测复现过）。所以最终调用
// enqueuePlayback 时必须带上这个 sequence，交给播放队列自己按顺序重排，不是这个函数
// 直接决定播放顺序。
//
// transcribeResult：这句话的 STT 结果，voice-listener.js 已经在音频流边到边推送的
// 同时并行做完了流式转录（VAD 判定这句话开始时开一路 STT 流，判定结束时关流拿最终
// 结果），不是这个函数自己去调用 STT——省掉了"整句说完 → 落盘 → 整段发送 → 等响应"
// 这段串行等待，是本次改动（STT 从 pre-recorded 换成流式）的核心目的。null 代表这句话
// 对应的流式 STT 连接在拿到最终结果之前中途失败了（网络中断、供应商报错）——不做任何
// "退回旧的 pre-recorded 方式重试"的兜底，直接判定这句话失败（见下面函数体里的早期
// return 分支）。
//
// 这个函数不是每次调用都会真的播放东西（比如目标语言没设置、翻译结果为空这些分支会
// 提前 return，不产出任何音频）——但 sequence 号码已经在调用方那边分配出去了，就算
// 这次不播放，也必须显式告诉播放队列"这个号位跳过、不用等了"（skipPlaybackSequence），
// 不然播放队列的重排缓冲区会一直卡在等一个永远不会到来的号码，后面所有已经处理完、
// 排在它后面的句子全部播不出来。用 try/finally 包住整个函数体，保证不管从哪个分支
// return、还是走到最后正常播放完，enqueuePlayback 和 skipPlaybackSequence 里
// 有且只有一个会被调用，不用在每个 return 语句那里都手动加一遍。
export async function handleSegment(
  guildId: string,
  connection: VoiceConnection,
  voiceChannel: VoiceBasedChannel,
  userId: string,
  monoFloat32: Float32Array,
  speakerState: SpeakerState,
  sequence: number,
  transcribeResult: TranscribeResult | null,
): Promise<void> {
  // t0：VAD 刚判定"这句话说完了"的那一刻，后面每一步都相对这个时间点打耗时，
  // 方便定位延迟到底卡在哪一环（STT 网络请求？翻译？TTS？还是别的地方）。
  const t0 = Date.now();
  const elapsed = () => `${Date.now() - t0}ms`;
  const who = speakerState.label ?? userId;
  // 每条日志都带上这三个字段，方便以后按 guild/说话人/句子搜（sequence 就是
  // session.js 分配的那个播放顺序号，同一句话从 STT 到播放全程都是同一个值）。
  const ctx = { guildId, userId, sequence };

  let enqueued = false;
  try {
    // 播放队列积压检查：这一刻（voice-listener.js 已经在这句话进 handleSegment 之前
    // 调过 markMaking，见 playback-queue.js）能拿到最新的排队深度。不管这句话最终这段
    // 音频出不出得来，"排队排太长"这件事本身就值得提醒——所以放在最前面，不依赖
    // 下面 STT/翻译/TTS 是否成功。checkBacklogWarning 内部已经做了边沿检测，这里不用
    // 关心"是不是已经提醒过"。
    if (checkBacklogWarning(guildId)) {
      logger.info({ ...ctx, who }, `${who} playback queue backlog exceeded threshold, sending slow-down reminder`);
      await sendBacklogWarningReminder(voiceChannel);
    }

    detectSpeakerGender(speakerState, monoFloat32);
    await saveSpeaker(guildId, userId, speakerState);

    // 流式 STT 连接在拿到最终结果之前中途失败（网络中断、供应商报错）时，
    // voice-listener.js 的 closeSttStream 已经把这种情况转成 null 传过来——不做任何
    // "退回旧的 pre-recorded 方式重试"的兜底（见 DESIGN.md），直接判定这句话失败，
    // 不进入术语检测/翻译/播放。sequence 号在 voice-listener.js 里已经同步分配过了，
    // 这里提前 return，交给下面的 finally 块统一 skipPlaybackSequence，跟"目标语言
    // 未设置"等其他提前 return 分支走同一套模式，不用在这里手动调用一遍。
    if (!transcribeResult) {
      logger.info({ ...ctx, who }, `${who} streamed STT failed for this segment, skipping translate/playback`);
      return;
    }

    const session = await getSession(guildId);
    if (!session?.sourceLang || !session?.targetLang) {
      // source/target 任意一个没设置过（都没有默认值，也都没有自动检测兜底，见
      // session.js）——不翻译、不消耗翻译额度，每次说话都直接发一条固定文字提示，
      // 逼着用户先 /config source:<语言> target:<语言> 一次。
      logger.info({ ...ctx, who }, `${who} source/target language not fully configured, skipping translate, sending text reminder`);
      await sendConfigNotSetReminder(voiceChannel);
      return;
    }

    const stamp = Date.now();
    logger.info({ ...ctx, who, sourceLang: session.sourceLang }, `${who} source language: ${session.sourceLang}`);

    const targetLang = session.targetLang;
    const provider = session.ttsProvider; // 跟 targetLang 一起在 setTargetLang 里联动设置，见 session.js
    // targetLang 是基础语言码，正好匹配术语库译词表、音色池和 TTS provider 路由。
    // 翻译 prompt 对 zh 的繁中偏好在 translation-prompt.js 内部处理，不影响这里的查表。
    const baseTargetLang = targetLang;

    // STT 这一步已经在 voice-listener.js 里跟音频流并行做完了：VAD 判定这句话开始的
    // 同时开一路流式 STT 连接，说话过程中 PCM 边到边推过去，判定说完时关流拿最终结果——
    // 不再像 pre-recorded 时代那样自己把整段音频落盘、发一次完整请求再等响应。
    // transcribeResult 就是调用方（voice-listener.js 的 handleDetectedSegment）已经
    // 拿到手的最终转写结果，wav 落盘（备份用途）搬到了 TASK-02，这里不落盘。
    const result = transcribeResult;
    logger.info({ ...ctx, who, elapsedMs: Date.now() - t0 }, `${who} [${elapsed()}] using streamed STT result`);
    const sttUsageLog = {
        event: 'external_api_usage',
        stage: 'stt',
        ...ctx,
        who,
        sourceLang: session.sourceLang,
        provider: result.usage?.provider,
        model: result.usage?.model,
        elapsedMs: result.usage?.elapsedMs,
        audioDurationSec: monoFloat32.length / 16000,
        providerAudioDurationSec: result.usage?.audioDurationSec,
        audioBytes: result.usage?.audioBytes,
        chunkCount: result.usage?.chunkCount,
        keytermCount: result.usage?.keytermCount,
      } as const;
    logger.info(sttUsageLog, 'External API usage: STT transcription');
    await recordExternalApiUsage(sttUsageLog);

    const transcriptText = result.text?.trim();
    if (!transcriptText) {
      logger.info({ ...ctx, who }, `${who} no text recognized from this segment, skipping`);
      return;
    }

    const billingDecision = await checkTranslateAllowed(guildId, session, transcriptText.length);
    if (!billingDecision.allowed) {
      logger.info(
        { ...ctx, who, planId: billingDecision.planId, reason: billingDecision.reason },
        `${who} billing limit blocked translation: ${billingDecision.reason}`,
      );
      // userMessage 可能是 undefined——daily limit 撞线这类原因当天已经提醒过一次了
      // （见 billing-service.js 的 shouldSendBillingNotification），这种情况不重复发
      // 消息刷屏，但翻译该拦还是拦（上面已经 return 了）。其余原因（账号状态异常、
      // 语言不在套餐范围）没有去重逻辑，userMessage 总是有值。
      if (billingDecision.userMessage) {
        await sendBillingBlockedReminder(voiceChannel, billingDecision.userMessage);
      }
      return;
    }
    if (billingDecision.warningMessage) {
      await sendBillingWarningReminder(voiceChannel, billingDecision.warningMessage);
    }

    logger.info({ ...ctx, who, transcript: transcriptText }, `${who} transcript: "${transcriptText}"`);
    speakerState.lastTranscript = transcriptText;
    await saveSpeaker(guildId, userId, speakerState);

    // 翻译缓存：具体"哪些源语言接入了缓存、怎么规范化"完全是 translate-cache-lookup.js
    // 的内部细节（目前只有中文，见 DESIGN.md「Scope」）——这里只认它返回的四种结果，
    // 以后加别的语言的缓存支持，改那个文件就够了，不用碰这里。
    const cacheLookup = await lookupTranslationCache({
      sourceLang: session.sourceLang,
      targetLang,
      gameId: session.game,
      transcriptText,
    });
    logger.info(
      {
        event: 'translation_cache_lookup',
        ...ctx,
        who,
        sourceLang: session.sourceLang,
        targetLang,
        gameId: session.game ?? null,
        cacheResult: cacheLookup.kind,
        cacheKey: 'cacheKey' in cacheLookup ? cacheLookup.cacheKey : undefined,
        transcriptTextChars: transcriptText.length,
        normalizedTextChars: 'normalizedText' in cacheLookup ? cacheLookup.normalizedText.length : undefined,
        cachedTranslationChars: cacheLookup.kind === 'hit' ? cacheLookup.translatedText.length : undefined,
      },
      'Translation cache lookup',
    );

    if (cacheLookup.kind === 'empty-after-normalize') {
      // 规范化完之后是空字符串，代表这句话是纯语气词/噪音——不翻译，没有输出，
      // 也不会走到下面写缓存那一步，见 DESIGN.md。
      logger.info({ ...ctx, who }, `${who} normalized to empty (pure filler words), skipping translate/playback`);
      return;
    }

    // not-applicable：这个源语言没接入缓存，textForTranslation 就是原始转写文本，
    // 跟改动前的行为完全一致。miss：用规范化后的文本继续走翻译，保证"缓存里存的译文"
    // 对应的就是"重新翻译会送进 LLM 的那份文本"，不会出现 key 用规范化文本、翻译却用
    // 原文这种不一致。
    let textForTranslation = transcriptText;
    let cacheKey: string | undefined;
    let translatedText: string | undefined;

    if (cacheLookup.kind === 'hit') {
      cacheKey = cacheLookup.cacheKey;
      translatedText = cacheLookup.translatedText;
      logger.info({ ...ctx, who, cacheKey }, `${who} translation cache hit, skipping LLM translation: "${translatedText}"`);
    } else if (cacheLookup.kind === 'miss') {
      textForTranslation = cacheLookup.textForTranslation;
      cacheKey = cacheLookup.cacheKey;
    }

    if (translatedText === undefined) {
      // 术语库检测：命中当前 /game 选定游戏的黑话就本地换成目标语言真实译词、用 <keep>
      // 包住，让 LLM 只管调整周围语法，标签内容不许动。Phase A 先不做翻译后校验，靠下面
      // 这条日志人工盯 LLM 有没有老实遵循标签指令（见 CLAUDE.md「游戏黑话/专有名词术语库」）。
      const { text: preparedText, hitCount } = applyTerminology(
        textForTranslation,
        session.sourceLang,
        baseTargetLang,
        session?.game,
      );
      if (hitCount > 0) {
        logger.info({ ...ctx, who, hitCount, preparedText }, `${who} matched ${hitCount} term(s), sending to translation after preprocessing: "${preparedText}"`);
      }

      const rawTranslatedText = await translate(preparedText, targetLang, {
        logContext: { ...ctx, who, sourceLang: session.sourceLang, targetLang },
      });
      logger.info({ ...ctx, who, elapsedMs: Date.now() - t0 }, `${who} [${elapsed()}] translation returned`);
      if (hitCount > 0) {
        logger.info({ ...ctx, who, rawTranslatedText }, `${who} raw translation output (for verification, includes <keep> tags): "${rawTranslatedText}"`);
      }
      translatedText = stripKeepTags(rawTranslatedText);
      logger.info({ ...ctx, who, targetLang, translatedText }, `${who} translation (${targetLang}): "${translatedText}"`);

      if (cacheKey && translatedText) {
        // 不 await：写缓存不该拖慢这句话本身的播放，跟下面 saveOutputRecording 不等
        // 落盘完成是同一个思路。setCachedTranslation 内部已经 try/catch 兜底了
        // Redis 不可用/超时的情况（见 adapter/out/redis/translate-cache.js），
        // 这里不用再包一层，写失败顶多是下次同样的话还得重新翻译一次。
        setCachedTranslation(cacheKey, translatedText);
      }
    }

    if (!translatedText) {
      logger.info({ ...ctx, who }, `${who} translation result is empty, skipping playback`);
      return;
    }
    if (!provider) {
      // 之前这里是纯静默 return——译文其实已经产出了，但因为这个目标语言不在
      // TTS_PROVIDER_BY_LANG 里、没有对应供应商，播放这一步被跳过，日志上完全看不出
      // 发生了什么，排查起来像是整条链路挂了。加一行日志，至少让人一眼看出"翻译成功了，
      // 只是这个语言没法播报"，不是别的环节坏了。
      logger.info(
        { ...ctx, who, targetLang },
        `${who} target language "${targetLang}" has no corresponding TTS provider, translated text only, no voice playback`,
      );
      return;
    }

    const voice = TTS_VOICE_OVERRIDE ?? (await resolveSpeakerVoice(guildId, userId, speakerState, provider, baseTargetLang));
    const ttsWav = await synthesize(translatedText, {
      voice,
      targetLang,
      provider,
      logContext: { ...ctx, who, sourceLang: session.sourceLang, targetLang },
    });
    logger.info(
      { ...ctx, who, elapsedMs: Date.now() - t0, provider, voice },
      `${who} [${elapsed()}] TTS returned (provider: ${provider}, voice: ${voice}), entering playback queue`,
    );
    // 不 await：这只是留档用的调试录音，转 PCM/播放只依赖内存里的 ttsWav，
    // 不需要等落盘完成才能继续；落盘失败也不该拖慢或打断播放，用 .catch 单独兜底。
    saveOutputRecording(userId, stamp, ttsWav).catch((err) => logger.error({ err, userId, stamp }, 'Failed to save output recording'));

    const pcm = ttsWavToDiscordPcm(ttsWav);
    enqueuePlayback(guildId, connection, pcm, sequence);
    enqueued = true;
  } finally {
    // 不管上面从哪个分支 return、还是正常走到最后播放，这个 sequence 号位必须有
    // 且只有一次交代：真播放了就不用管（enqueued 已经是 true）；没播放（提前
    // return 的那些分支）就显式告诉播放队列跳过这个号位，不然重排缓冲区会一直
    // 卡住等一个不会来的号码（见 playback-queue.js 顶部注释）。
    if (!enqueued) skipPlaybackSequence(guildId, connection, sequence);
  }
}
