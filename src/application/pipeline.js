import { ttsWavToDiscordPcm } from '../domain/wav.js';
import { estimateGender } from '../domain/pitch.js';
import { applyTerminology, stripKeepTags } from '../domain/terminology.js';
import { saveInputRecording, deleteRecording, saveOutputRecording } from '../adapter/out/recordings.js';
import { transcribe, SUPPORTED_SOURCE_LANGS } from './ports/stt.js';
import { translate } from './ports/translate.js';
import { synthesize } from './ports/tts.js';
import { enqueuePlayback, skipPlaybackSequence } from '../adapter/out/playback-queue.js';
import { getSession, listSpeakers, setSourceLang } from './session.js';
import { assignVoice } from './voice-assignment.js';
import { createLogger } from '../adapter/out/logger.js';

const logger = createLogger('pipeline');

// 显式设置 TTS_VOICE 就强制所有人用同一个音色（调试/回退用）；不设置就默认按
// 每个说话人检测到的性别、当前 session.ttsProvider 分配音色（见 resolveSpeakerVoice）。
// 注意：多供应商场景下这个覆盖值只对"当前恰好路由到的那个供应商"有效——比如设成一个
// Deepgram 的音色名，目标语言换成 zh、路由去了 azure，这个覆盖值就是无效的音色名，
// 会在 synthesize 里报错。这是调试/回退功能本来的定位（单一供应商场景下用），
// 多供应商场景下用这个覆盖要自己确认当前目标语言实际会路由到哪个供应商。
const TTS_VOICE_OVERRIDE = process.env.TTS_VOICE || undefined;

// 目标语言还没设置时发的固定文字提示——改用文字而不是语音播报：语音播报依赖 TTS
// 供应商这条链路本身（会经过 synthesize/播放队列，任何一环出问题都可能又变成
// "静默失败、听不到声音也看不出哪里错了"，之前已经踩过一次这个坑），文字消息走
// session.voiceChannel.send，不依赖 TTS，链路更短、失败了控制台也看得到明确报错。
// 这里可以直接把命令语法写全（比如反引号包住的 /lang target:<language>）——文字
// 不用考虑"念出来怪不怪"这个语音场景才有的限制。
const TARGET_LANG_NOT_SET_MESSAGE =
  "⚠️ I can't translate yet — set a target language first with `/lang target:<language>`.";

async function sendTargetLangNotSetReminder(session) {
  await session.voiceChannel
    ?.send(TARGET_LANG_NOT_SET_MESSAGE)
    .catch((err) => logger.error({ err }, '发送目标语言未设置提示失败'));
}

// 说话人第一次开口时判断性别，纯声学特征、跟 TTS 供应商无关，只需要判一次、
// 整场会话不变（不会因为目标语言/供应商切换而重新判断）。
function detectSpeakerGender(speakerState, monoFloat32) {
  if (speakerState.gender) return; // 已经判过，跳过

  const { gender, medianHz } = estimateGender(monoFloat32);
  speakerState.gender = gender;

  const pitchInfo = medianHz ? `基频≈${medianHz.toFixed(0)}Hz` : '音量太低/太短，无法判断，随机选的';
  logger.info(
    { speaker: speakerState.label, gender, medianHz: medianHz ?? null },
    `${speakerState.label} 首次开口，判定性别=${gender}（${pitchInfo}）`,
  );
}

// 每个说话人在每个"供应商+语言"组合下各自固定一个音色，缓存在
// speakerState.voicesByProviderLang（"provider:lang" -> voice）。缓存 key 必须是
// 供应商+语言的组合，不能只按供应商——同一个供应商可能覆盖好几种语言（比如 deepgram
// 覆盖 en/fr/ja/de/es），只按供应商缓存的话，同一个人从 target:en 切到 target:fr
// （两者都路由到 deepgram，供应商没变）会直接复用缓存的英语音色去读法语文本，音色
// 跟语言对不上。不同供应商的音色命名空间也完全不通用（Deepgram 是"aura-2-xxx-en"
// 这种，Azure 是"zh-TW-XxxNeural"这种），没法直接复用同一个音色名；供应商或语言
// 变化都会给新组合单独分配一个（跟旧组合听感未必一致，这是多供应商架构没法避免的
// 取舍——同一个人切换目标语言前后，声音可能会变）。只要"供应商+语言"这个组合没变，
// 同一个说话人的音色整场保持不变。
function resolveSpeakerVoice(guildId, speakerState, provider, lang) {
  speakerState.voicesByProviderLang ??= {};
  const cacheKey = `${provider}:${lang}`;
  if (speakerState.voicesByProviderLang[cacheKey]) return speakerState.voicesByProviderLang[cacheKey];

  const usedVoices = new Set(
    Array.from(listSpeakers(guildId))
      .filter((speaker) => speaker !== speakerState)
      .map((speaker) => speaker.voicesByProviderLang?.[cacheKey])
      .filter(Boolean),
  );
  const voice = assignVoice(speakerState.gender, usedVoices, provider, lang);
  speakerState.voicesByProviderLang[cacheKey] = voice;
  logger.info(
    { speaker: speakerState.label, provider, lang, voice },
    `${speakerState.label} 首次用 ${provider}(${lang}) 播报，分配音色：${voice}`,
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
// 这个函数不是每次调用都会真的播放东西（比如目标语言没设置、翻译结果为空这些分支会
// 提前 return，不产出任何音频）——但 sequence 号码已经在调用方那边分配出去了，就算
// 这次不播放，也必须显式告诉播放队列"这个号位跳过、不用等了"（skipPlaybackSequence），
// 不然播放队列的重排缓冲区会一直卡在等一个永远不会到来的号码，后面所有已经处理完、
// 排在它后面的句子全部播不出来。用 try/finally 包住整个函数体，保证不管从哪个分支
// return、还是走到最后正常播放完，enqueuePlayback 和 skipPlaybackSequence 里
// 有且只有一个会被调用，不用在每个 return 语句那里都手动加一遍。
export async function handleSegment(guildId, connection, userId, monoFloat32, speakerState, sequence) {
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
    detectSpeakerGender(speakerState, monoFloat32);

    const session = getSession(guildId);
    if (!session?.targetLang) {
      // 目标语言从没设置过（没有默认值，见 session.js）——不翻译、不消耗 STT/翻译额度，
      // 每次说话都直接发一条固定文字提示，逼着用户先 /lang target:<语言> 一次。
      logger.info({ ...ctx, who }, `${who} 目标语言未设置，跳过 STT/翻译，发文字提示`);
      await sendTargetLangNotSetReminder(session);
      return;
    }

    const stamp = Date.now();
    const segmentFile = await saveInputRecording(userId, stamp, monoFloat32, 16000);
    logger.info({ ...ctx, who, elapsedMs: Date.now() - t0 }, `${who} [${elapsed()}] 音频已存盘，开始 STT`);

    // 源语言没手动设置过（session.sourceLang 是假值）就交给 STT 自动检测——记下这次调用
    // 之前是不是这个状态，STT 返回之后好判断这次是不是"第一句话，需要锁定检测结果"。
    const wasSourceLangUnset = !session.sourceLang;
    if (session.sourceLang) {
      logger.info({ ...ctx, who, sourceLang: session.sourceLang }, `${who} 源语言：${session.sourceLang}`);
    } else {
      logger.info({ ...ctx, who }, `${who} 源语言尚未设置，本次调用 STT 自动检测`);
    }

    const targetLang = session.targetLang;
    const provider = session.ttsProvider; // 跟 targetLang 一起在 setTargetLang 里联动设置，见 session.js
    let result;
    try {
      result = await transcribe(segmentFile, {
        language: session.sourceLang,
        prompt: speakerState.lastTranscript,
      });
    } finally {
      // SAVE_RECORDINGS=false 时这份只是喂 STT 用的临时文件，用完即删；
      // =true 时是留存证据，deleteRecording 内部是 no-op。
      await deleteRecording(segmentFile);
    }
    logger.info({ ...ctx, who, elapsedMs: Date.now() - t0 }, `${who} [${elapsed()}] STT 返回`);

    // 这次是自动检测、且真的检测出语种了——锁定进 session（跟 /lang source:<语言> 手动
    // 设置效果一样，走同一个 setSourceLang，之后所有人共用这个源语言，不用每句话都重新
    // 检测）。是 session 级别的锁定，不是按说话人各自锁定——跟 sourceLang/targetLang
    // 本来就是整个 guild 共享一份设置这件事保持一致。
    //
    // 只信 SUPPORTED_SOURCE_LANGS 范围内的检测结果——极短音频（比如就一两个词）的语种
    // 检测本身不可靠，实测出现过"hello hello"（0.86 秒）被 Deepgram 判成 cs（捷克语）
    // 这种明显错误的结果，也出现过说印尼语被判成 id（不在支持范围内，本身没错，但项目
    // 没打算支持这个语言）。检测结果不在这个白名单里就不锁定——真锁进去的话，之后整场
    // 会话都会按这个错误语言去偏置 STT，会把后续所有语音都识别成乱码，比"没能自动锁定"
    // 严重得多。
    //
    // 但不锁定不等于什么都不说——一开始这里是纯打日志、不通知用户，结果出现过"检测失败
    // 后一直卡着不锁定，用户完全不知道发生了什么、也不知道要自己去 /lang source: 设置"
    // 这种体验落差。现在改成主动发文字提示，跟"target 语言未设置"那条提示是同一个思路：
    // 宁可可能连续提示几次，也不要让用户在没有任何反馈的情况下自己纳闷。
    if (wasSourceLangUnset && result.language) {
      if (!SUPPORTED_SOURCE_LANGS.includes(result.language)) {
        logger.info(
          { ...ctx, who, detectedLang: result.language },
          `${who} 自动检测到源语言："${result.language}"，不在支持范围(${SUPPORTED_SOURCE_LANGS.join('/')})内，提示用户手动设置`,
        );
        session.voiceChannel
          ?.send(
            `⚠️ Couldn't auto-detect your language (got "${result.language}", which isn't supported). ` +
              'Please set it manually with `/lang source:<language>`.',
          )
          .catch((err) => logger.error({ err }, '发送源语言检测失败通知失败'));
        // 源语言没能确认下来，这段话的翻译/播报就没有意义——不往下走了。之前这里没有
        // return，导致刚提示完用户"没检测出你的语言、请手动设置"，紧接着又拿这句话
        // （语言都没确认）翻译播报出来，逻辑上前后矛盾，体验也很奇怪。
        return;
      } else {
        setSourceLang(guildId, result.language);
        logger.info({ ...ctx, who, detectedLang: result.language }, `${who} 自动检测到源语言：${result.language}，已锁定`);
        session.voiceChannel
          ?.send(
            `🌐 Detected and set the source language to **${result.language}** based on the first thing said. ` +
              'Is that correct? If not, set it manually with `/lang source:<language>`.',
          )
          .catch((err) => logger.error({ err }, '发送自动检测语言通知失败'));
      }
    }

    const transcriptText = result.text?.trim();
    if (!transcriptText) {
      logger.info({ ...ctx, who }, `${who} 说的这段没识别出文字，跳过`);
      return;
    }
    logger.info({ ...ctx, who, transcript: transcriptText }, `${who} 原文: "${transcriptText}"`);
    speakerState.lastTranscript = transcriptText;

    // 术语库检测：命中当前 /game 选定游戏的黑话就本地换成目标语言真实译词、用 <keep>
    // 包住，让 LLM 只管调整周围语法，标签内容不许动。Phase A 先不做翻译后校验，靠下面
    // 这条日志人工盯 LLM 有没有老实遵循标签指令（见 CLAUDE.md「游戏黑话/专有名词术语库」）。
    const { text: preparedText, hitCount } = applyTerminology(
      transcriptText,
      session.sourceLang,
      targetLang,
      session?.game,
    );
    if (hitCount > 0) {
      logger.info({ ...ctx, who, hitCount, preparedText }, `${who} 命中 ${hitCount} 个术语，预处理后送翻译: "${preparedText}"`);
    }

    const rawTranslatedText = await translate(preparedText, targetLang);
    logger.info({ ...ctx, who, elapsedMs: Date.now() - t0 }, `${who} [${elapsed()}] 翻译返回`);
    if (hitCount > 0) {
      logger.info({ ...ctx, who, rawTranslatedText }, `${who} 翻译原始输出(校验用，含 <keep> 标签): "${rawTranslatedText}"`);
    }
    const translatedText = stripKeepTags(rawTranslatedText);
    logger.info({ ...ctx, who, targetLang, translatedText }, `${who} 译文(${targetLang}): "${translatedText}"`);

    if (!translatedText) {
      logger.info({ ...ctx, who }, `${who} 翻译结果为空，跳过播放`);
      return;
    }
    if (!provider) {
      // 之前这里是纯静默 return——译文其实已经产出了，但因为这个目标语言不在
      // TTS_PROVIDER_BY_LANG 里、没有对应供应商，播放这一步被跳过，日志上完全看不出
      // 发生了什么，排查起来像是整条链路挂了。加一行日志，至少让人一眼看出"翻译成功了，
      // 只是这个语言没法播报"，不是别的环节坏了。
      logger.info(
        { ...ctx, who, targetLang },
        `${who} 目标语言 "${targetLang}" 没有对应的 TTS 供应商，只有译文没有语音播报`,
      );
      return;
    }

    const voice = TTS_VOICE_OVERRIDE ?? resolveSpeakerVoice(guildId, speakerState, provider, targetLang);
    const ttsWav = await synthesize(translatedText, { voice, targetLang, provider });
    logger.info(
      { ...ctx, who, elapsedMs: Date.now() - t0, provider, voice },
      `${who} [${elapsed()}] TTS 返回（供应商：${provider}，音色：${voice}），进入播放队列`,
    );
    await saveOutputRecording(userId, stamp, ttsWav);

    const pcm = ttsWavToDiscordPcm(ttsWav);
    enqueuePlayback(guildId, connection, pcm, sequence);
    enqueued = true;
  } finally {
    // 不管上面从哪个分支 return、还是正常走到最后播放，这个 sequence 号位必须有
    // 且只有一次交代：真播放了就不用管（enqueued 已经是 true）；没播放（提前
    // return 的那些分支）就显式告诉播放队列跳过这个号位，不然重排缓冲区会一直
    // 卡住等一个不会来的号码（见 playback-queue.js 顶部注释）。
    if (!enqueued) skipPlaybackSequence(guildId, sequence);
  }
}
