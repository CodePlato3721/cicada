import { ttsWavToDiscordPcm } from '../domain/wav.js';
import { estimateGender } from '../domain/pitch.js';
import { saveInputRecording, deleteRecording, saveOutputRecording } from '../adapter/out/recordings.js';
import { transcribe } from './ports/stt.js';
import { translate } from './ports/translate.js';
import { synthesize, TTS_SUPPORTED_LANGS } from './ports/tts.js';
import { enqueuePlayback } from '../adapter/out/playback-queue.js';
import { getSession, listSpeakers } from './session.js';
import { assignVoice } from './voice-assignment.js';

const TARGET_LANG = process.env.TRANSLATE_TARGET_LANG ?? 'en';
// 显式设置 TTS_VOICE 就强制所有人用同一个音色（调试/回退用）；不设置就默认按
// 每个说话人检测到的性别分配音色（见 assignSpeakerVoice），整场会话保持不变。
const TTS_VOICE_OVERRIDE = process.env.TTS_VOICE || undefined;
// 哪些目标语言支持出语音（而不只是出文字）由当前 TTS_PROVIDER 决定——
// Groq(Orpheus) 只支持英/阿，Qwen 支持中/英/日韩等更多语言，见对应 adapter 的 TTS_SUPPORTED_LANGS。

// 说话人第一次开口时，用这段语音判断性别、分配一个音色，之后整场会话固定用这个音色
// （不会中途换声音）。判不出性别也没关系，直接在全部音色里随便选一个，不阻塞流程。
function assignSpeakerVoice(guildId, speakerState, monoFloat32) {
  if (speakerState.voice) return; // 已经分配过，跳过

  const { gender, medianHz } = estimateGender(monoFloat32);
  const usedVoices = new Set(
    Array.from(listSpeakers(guildId))
      .filter((speaker) => speaker !== speakerState && speaker.voice)
      .map((speaker) => speaker.voice),
  );
  speakerState.voice = assignVoice(gender, usedVoices);

  const pitchInfo = medianHz ? `基频≈${medianHz.toFixed(0)}Hz` : '音量太低/太短，无法判断，随机选的';
  console.log(`[pipeline] ${speakerState.label} 首次开口，判定性别=${gender}（${pitchInfo}），分配音色：${speakerState.voice}`);
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

  assignSpeakerVoice(guildId, speakerState, monoFloat32);

  const stamp = Date.now();
  const segmentFile = await saveInputRecording(userId, stamp, monoFloat32, 16000);
  console.log(`[pipeline] ${who} [${elapsed()}] 音频已存盘，开始 STT`);

  const sourceLang = getSession(guildId)?.sourceLang;
  let result;
  try {
    result = await transcribe(segmentFile, {
      language: sourceLang,
      prompt: speakerState.lastTranscript,
    });
  } finally {
    // SAVE_RECORDINGS=false 时这份只是喂 STT 用的临时文件，用完即删；
    // =true 时是留存证据，deleteRecording 内部是 no-op。
    await deleteRecording(segmentFile);
  }
  console.log(`[pipeline] ${who} [${elapsed()}] STT 返回`);
  const transcriptText = result.text?.trim();
  if (!transcriptText) {
    console.log(`[pipeline] ${who} 说的这段没识别出文字，跳过`);
    return;
  }
  console.log(`[pipeline] ${who} 原文: "${transcriptText}"`);
  speakerState.lastTranscript = transcriptText;

  const translatedText = await translate(transcriptText, TARGET_LANG);
  console.log(`[pipeline] ${who} [${elapsed()}] 翻译返回`);
  console.log(`[pipeline] ${who} 译文(${TARGET_LANG}): "${translatedText}"`);

  if (!TTS_SUPPORTED_LANGS.includes(TARGET_LANG) || !translatedText) {
    return;
  }

  const ttsWav = await synthesize(translatedText, { voice: TTS_VOICE_OVERRIDE ?? speakerState.voice, targetLang: TARGET_LANG });
  console.log(`[pipeline] ${who} [${elapsed()}] TTS 返回（音色：${TTS_VOICE_OVERRIDE ?? speakerState.voice}），进入播放队列`);
  await saveOutputRecording(userId, stamp, ttsWav);

  const pcm = ttsWavToDiscordPcm(ttsWav);
  enqueuePlayback(guildId, connection, pcm);
}
