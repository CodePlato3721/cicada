import { ttsWavToDiscordPcm } from '../domain/wav.js';
import { estimateGender } from '../domain/pitch.js';
import { applyTerminology, stripKeepTags } from '../domain/terminology.js';
import { saveInputRecording, deleteRecording, saveOutputRecording } from '../adapter/out/recordings.js';
import { transcribe } from './ports/stt.js';
import { translate } from './ports/translate.js';
import { synthesize } from './ports/tts.js';
import { enqueuePlayback } from '../adapter/out/playback-queue.js';
import { getSession, listSpeakers, setSourceLang } from './session.js';
import { assignVoice } from './voice-assignment.js';

// 显式设置 TTS_VOICE 就强制所有人用同一个音色（调试/回退用）；不设置就默认按
// 每个说话人检测到的性别、当前 session.ttsProvider 分配音色（见 resolveSpeakerVoice）。
// 注意：多供应商场景下这个覆盖值只对"当前恰好路由到的那个供应商"有效——比如设成一个
// Deepgram 的音色名，目标语言换成 zh、路由去了 azure，这个覆盖值就是无效的音色名，
// 会在 synthesize 里报错。这是调试/回退功能本来的定位（单一供应商场景下用），
// 多供应商场景下用这个覆盖要自己确认当前目标语言实际会路由到哪个供应商。
const TTS_VOICE_OVERRIDE = process.env.TTS_VOICE || undefined;

// 目标语言还没设置时播报的固定提示——不翻译、不经过 LLM，永远走 deepgram + 英文念
// （这条提示本身不看 session.ttsProvider，因为这时候 targetLang 可能压根还没设置过，
// 没有 provider 上下文可用；固定用一个保底组合，保证提示本身播得出来）。内容特意不
// 逐字念 "/lang target:xx" 这种命令语法（念出来很怪），只说清楚"现在没法翻译、要先
// 设置"这件事，具体怎么设置由 /join 的文字回复说明。
const TARGET_LANG_NOT_SET_MESSAGE =
  "I can't translate yet — please set a target language first using the lang command.";
const TARGET_LANG_NOT_SET_VOICE = 'aura-2-orion-en';

async function playTargetLangNotSetReminder(guildId, connection, userId, stamp) {
  const ttsWav = await synthesize(TARGET_LANG_NOT_SET_MESSAGE, {
    voice: TARGET_LANG_NOT_SET_VOICE,
    targetLang: 'en',
    provider: 'deepgram',
  });
  await saveOutputRecording(userId, stamp, ttsWav);
  const pcm = ttsWavToDiscordPcm(ttsWav);
  enqueuePlayback(guildId, connection, pcm);
}

// 说话人第一次开口时判断性别，纯声学特征、跟 TTS 供应商无关，只需要判一次、
// 整场会话不变（不会因为目标语言/供应商切换而重新判断）。
function detectSpeakerGender(speakerState, monoFloat32) {
  if (speakerState.gender) return; // 已经判过，跳过

  const { gender, medianHz } = estimateGender(monoFloat32);
  speakerState.gender = gender;

  const pitchInfo = medianHz ? `基频≈${medianHz.toFixed(0)}Hz` : '音量太低/太短，无法判断，随机选的';
  console.log(`[pipeline] ${speakerState.label} 首次开口，判定性别=${gender}（${pitchInfo}）`);
}

// 每个说话人在每个 TTS 供应商下各自固定一个音色，缓存在 speakerState.voicesByProvider
// （provider -> voice）。不同供应商的音色命名空间完全不通用（Deepgram 是
// "aura-2-xxx-en" 这种，Azure 是 "zh-TW-XxxNeural" 这种），没法直接复用同一个音色名；
// 目标语言变化导致供应商切换时，会给新供应商单独分配一个（跟旧供应商听感未必一致，
// 这是多供应商架构没法避免的取舍——同一个人切换目标语言前后，声音可能会变）。
// 只要供应商没变，同一个说话人在这个供应商下的音色整场保持不变。
function resolveSpeakerVoice(guildId, speakerState, provider) {
  speakerState.voicesByProvider ??= {};
  if (speakerState.voicesByProvider[provider]) return speakerState.voicesByProvider[provider];

  const usedVoices = new Set(
    Array.from(listSpeakers(guildId))
      .filter((speaker) => speaker !== speakerState)
      .map((speaker) => speaker.voicesByProvider?.[provider])
      .filter(Boolean),
  );
  const voice = assignVoice(speakerState.gender, usedVoices, provider);
  speakerState.voicesByProvider[provider] = voice;
  console.log(`[pipeline] ${speakerState.label} 首次用 ${provider} 播报，分配音色：${voice}`);
  return voice;
}

// 一段完整语音（16kHz 单声道 Float32）→ STT → 翻译 → TTS → 播放。
// 这个函数是"发射后不管"地被调用的，不会阻塞上面继续采集下一句话。
// 这是这个项目里唯一的"用例"，所以叫 pipeline 而不是 xxxService——名字更贴近它实际做的事。
export async function handleSegment(guildId, connection, userId, monoFloat32, speakerState) {
  // t0：VAD 刚判定"这句话说完了"的那一刻，后面每一步都相对这个时间点打耗时，
  // 方便定位延迟到底卡在哪一环（STT 网络请求？翻译？TTS？还是别的地方）。
  const t0 = Date.now();
  const elapsed = () => `${Date.now() - t0}ms`;
  const who = speakerState.label ?? userId;

  detectSpeakerGender(speakerState, monoFloat32);

  const session = getSession(guildId);
  if (!session?.targetLang) {
    // 目标语言从没设置过（没有默认值，见 session.js）——不翻译、不消耗 STT/翻译额度，
    // 每次说话都直接播报固定提示，逼着用户先 /lang target:<语言> 一次。
    console.log(`[pipeline] ${who} 目标语言未设置，跳过 STT/翻译，播报提示`);
    await playTargetLangNotSetReminder(guildId, connection, userId, Date.now());
    return;
  }

  const stamp = Date.now();
  const segmentFile = await saveInputRecording(userId, stamp, monoFloat32, 16000);
  console.log(`[pipeline] ${who} [${elapsed()}] 音频已存盘，开始 STT`);

  // 源语言没手动设置过（session.sourceLang 是假值）就交给 STT 自动检测——记下这次调用
  // 之前是不是这个状态，STT 返回之后好判断这次是不是"第一句话，需要锁定检测结果"。
  const wasSourceLangUnset = !session.sourceLang;
  if (session.sourceLang) {
    console.log(`[pipeline] ${who} 源语言：${session.sourceLang}`);
  } else {
    console.log(`[pipeline] ${who} 源语言尚未设置，本次调用 STT 自动检测`);
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
  console.log(`[pipeline] ${who} [${elapsed()}] STT 返回`);

  // 这次是自动检测、且真的检测出语种了——锁定进 session（跟 /lang source:<语言> 手动
  // 设置效果一样，走同一个 setSourceLang，之后所有人共用这个源语言，不用每句话都重新
  // 检测）。是 session 级别的锁定，不是按说话人各自锁定——跟 sourceLang/targetLang
  // 本来就是整个 guild 共享一份设置这件事保持一致。
  if (wasSourceLangUnset && result.language) {
    setSourceLang(guildId, result.language);
    console.log(`[pipeline] ${who} 自动检测到源语言：${result.language}，已锁定`);
    session.voiceChannel
      ?.send(
        `🌐 Detected and set the source language to **${result.language}** based on the first thing said. Use \`/lang source:<language>\` to change it.`,
      )
      .catch((err) => console.error('[pipeline] 发送自动检测语言通知失败：', err));
  }

  const transcriptText = result.text?.trim();
  if (!transcriptText) {
    console.log(`[pipeline] ${who} 说的这段没识别出文字，跳过`);
    return;
  }
  console.log(`[pipeline] ${who} 原文: "${transcriptText}"`);
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
    console.log(`[pipeline] ${who} 命中 ${hitCount} 个术语，预处理后送翻译: "${preparedText}"`);
  }

  const rawTranslatedText = await translate(preparedText, targetLang);
  console.log(`[pipeline] ${who} [${elapsed()}] 翻译返回`);
  if (hitCount > 0) {
    console.log(`[pipeline] ${who} 翻译原始输出(校验用，含 <keep> 标签): "${rawTranslatedText}"`);
  }
  const translatedText = stripKeepTags(rawTranslatedText);
  console.log(`[pipeline] ${who} 译文(${targetLang}): "${translatedText}"`);

  if (!translatedText) {
    console.log(`[pipeline] ${who} 翻译结果为空，跳过播放`);
    return;
  }
  if (!provider) {
    // 之前这里是纯静默 return——译文其实已经产出了，但因为这个目标语言不在
    // TTS_PROVIDER_BY_LANG 里、没有对应供应商，播放这一步被跳过，日志上完全看不出
    // 发生了什么，排查起来像是整条链路挂了。加一行日志，至少让人一眼看出"翻译成功了，
    // 只是这个语言没法播报"，不是别的环节坏了。
    console.log(`[pipeline] ${who} 目标语言 "${targetLang}" 没有对应的 TTS 供应商，只有译文没有语音播报`);
    return;
  }

  const voice = TTS_VOICE_OVERRIDE ?? resolveSpeakerVoice(guildId, speakerState, provider);
  const ttsWav = await synthesize(translatedText, { voice, targetLang, provider });
  console.log(`[pipeline] ${who} [${elapsed()}] TTS 返回（供应商：${provider}，音色：${voice}），进入播放队列`);
  await saveOutputRecording(userId, stamp, ttsWav);

  const pcm = ttsWavToDiscordPcm(ttsWav);
  enqueuePlayback(guildId, connection, pcm);
}
