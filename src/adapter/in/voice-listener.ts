import { EndBehaviorType, type VoiceConnection, type AudioReceiveStream } from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import prism from 'prism-media';
import type { opus } from 'prism-media';
import { StreamingVad } from '../../domain/streaming-vad.js';
import { getKeyterms } from '../../domain/keyterms.js';
import { stereoInt16BufferToMonoFloat32 } from '../../domain/pcm.js';
import { clearPlaybackQueue } from '../out/playback-queue.js';
import { saveInputRecording } from '../out/recordings.js';
import { handleSegment } from '../../application/pipeline.js';
import { openStream, type SttStream, type TranscribeResult } from '../../application/ports/stt.js';
import {
  createSession,
  getSession,
  deleteSession,
  addSpeaker,
  getSpeaker,
  nextPlaybackSequence,
  type SpeakerState,
} from '../../application/session.js';
import { createLogger } from '../out/logger.js';

const logger = createLogger('listener');
const AUDIO_DIAGNOSTICS_ENABLED = process.env.VOICE_AUDIO_DIAGNOSTICS !== 'false';
const AUDIO_DIAGNOSTICS_INTERVAL_MS = Number(process.env.VOICE_AUDIO_DIAGNOSTICS_INTERVAL_MS ?? 5000);

interface PcmAudioStats {
  sampleCount: number;
  sumSquares: number;
  peak: number;
}

function updatePcmAudioStats(stats: PcmAudioStats, chunk: Buffer): void {
  for (let offset = 0; offset + 1 < chunk.length; offset += 2) {
    const sample = chunk.readInt16LE(offset) / 32768;
    const abs = Math.abs(sample);
    stats.sumSquares += sample * sample;
    stats.sampleCount += 1;
    if (abs > stats.peak) stats.peak = abs;
  }
}

function roundedLevel(value: number): number {
  return Number(value.toFixed(4));
}

interface SpeakerVoiceRuntime {
  vad: StreamingVad;
  opusStream: AudioReceiveStream;
  decoder: opus.Decoder;
  // 占位后立即被 createSpeakerPipeline 里的真实实现覆盖（见下方），字段本身必须在
  // 对象字面量构造时就存在，不能是可选——forceEndSpeech() 会被 onSpeakingEnd 直接调用，
  // 不想每次调用都做一次"存在与否"的可选链判断。
  forceEndSpeech: () => void;
}

interface GuildVoiceRuntime {
  connection: VoiceConnection;
  voiceChannel: VoiceBasedChannel;
  speakers: Map<string, SpeakerVoiceRuntime>;
}

// guildId -> { onSpeakingStart, onSpeakingEnd }：Discord 事件监听器的引用，只用于
// /leave 时能对称地 off() 掉。这是纯 adapter 细节，不属于业务状态，不放进 application/session.js。
interface GuildListeners {
  onSpeakingStart: (userId: string) => void;
  onSpeakingEnd: (userId: string) => void;
}

const guildListeners = new Map<string, GuildListeners>();
const guildVoiceRuntimes = new Map<string, GuildVoiceRuntime>();
const startingSpeakerPipelines = new Set<string>();

function speakerRuntimeKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

function getSpeakerVoiceRuntime(guildId: string, userId: string): SpeakerVoiceRuntime | undefined {
  return guildVoiceRuntimes.get(guildId)?.speakers.get(userId);
}

function hasSpeakerVoiceRuntime(guildId: string, userId: string): boolean {
  return guildVoiceRuntimes.get(guildId)?.speakers.has(userId) ?? false;
}

function isSpeakerPipelineActiveOrStarting(guildId: string, userId: string): boolean {
  return hasSpeakerVoiceRuntime(guildId, userId) || startingSpeakerPipelines.has(speakerRuntimeKey(guildId, userId));
}

export async function startListening(connection: VoiceConnection, voiceChannel: VoiceBasedChannel): Promise<void> {
  const guildId = connection.joinConfig.guildId;

  // 如果之前有残留状态（比如重复 /join），先清掉再重新开始。
  await stopListening(guildId);

  await createSession(guildId);
  guildVoiceRuntimes.set(guildId, { connection, voiceChannel, speakers: new Map() });

  const onSpeakingStart = (userId: string) => {
    // 诊断用：Discord 检测到这个人开始说话的时刻，跟 VAD 确认"这是人声"的时刻对比，
    // 能看出是不是网络/@discordjs-voice 这一层就已经有延迟——两条日志各自的 time 字段
    // 就是时间点，不用再在消息文本里手动拼一遍时间。
    logger.info({ userId }, `${userId} Discord detected speaking started`);
    if (isSpeakerPipelineActiveOrStarting(guildId, userId)) return; // 已经在监听或正在初始化这个人了
    const key = speakerRuntimeKey(guildId, userId);
    startingSpeakerPipelines.add(key);
    createSpeakerPipeline(guildId, connection, voiceChannel, userId)
      .catch((err) => {
        logger.error({ err, userId }, `Failed to initialize listening for speaker ${userId}`);
      })
      .finally(() => {
        startingSpeakerPipelines.delete(key);
      });
  };

  // Discord 客户端真正沉默时根本不发音频包，我们自己"数安静帧"的判断永远等不到帧，
  // 只能靠这个连接层面的信号强制收尾，不然一句话会跟很久之后的下一句无限粘在一起。
  const onSpeakingEnd = (userId: string) => {
    getSpeakerVoiceRuntime(guildId, userId)?.forceEndSpeech();
  };

  guildListeners.set(guildId, { onSpeakingStart, onSpeakingEnd });
  connection.receiver.speaking.on('start', onSpeakingStart);
  connection.receiver.speaking.on('end', onSpeakingEnd);

  logger.info({ guildId }, `Started auto-listening to voice in guild ${guildId}`);
}

export async function stopListening(guildId: string): Promise<void> {
  const runtime = guildVoiceRuntimes.get(guildId);
  if (!runtime && !(await getSession(guildId))) return;

  const listeners = guildListeners.get(guildId);
  if (listeners) {
    if (runtime) {
      runtime.connection.receiver.speaking.off('start', listeners.onSpeakingStart);
      runtime.connection.receiver.speaking.off('end', listeners.onSpeakingEnd);
    }
    guildListeners.delete(guildId);
  }

  for (const speakerRuntime of runtime?.speakers.values() ?? []) {
    speakerRuntime.opusStream.destroy();
    speakerRuntime.decoder.destroy();
    speakerRuntime.vad.destroy().catch(() => {});
  }

  for (const key of Array.from(startingSpeakerPipelines)) {
    if (key.startsWith(`${guildId}:`)) startingSpeakerPipelines.delete(key);
  }

  guildVoiceRuntimes.delete(guildId);
  await deleteSession(guildId);
  clearPlaybackQueue(guildId);
  logger.info({ guildId }, `Stopped listening to guild ${guildId}`);
}

// jobQueue 里排队的两种任务：一块新到的音频（chunk）或者"强制结束这句话"（forceEnd）。
type SpeakerJob = { type: 'chunk'; data: Buffer } | { type: 'forceEnd' };

async function createSpeakerPipeline(
  guildId: string,
  connection: VoiceConnection,
  voiceChannel: VoiceBasedChannel,
  userId: string,
): Promise<void> {
  const vad = await StreamingVad.create();
  const guildRuntime = guildVoiceRuntimes.get(guildId);
  if (!guildRuntime) {
    await vad.destroy();
    return;
  }

  // Manual：不自动结束订阅，我们自己控制生命周期（/leave 时统一清理）。
  // "一句话说完没"完全交给上面的 VAD 实时判断，不再依赖 Discord 自带的静音计时。
  const opusStream = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.Manual },
  });
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });

  opusStream.pipe(decoder);

  let speakerState = await getSpeaker(guildId, userId);
  if (!speakerState) {
    speakerState = {
      lastTranscript: '',
    };
    await addSpeaker(guildId, userId, speakerState);
  }

  const speakerRuntime: SpeakerVoiceRuntime = {
    vad,
    opusStream,
    decoder,
    forceEndSpeech: () => {},
  };

  // 这句话对应的流式 STT 连接。它从这个 speaker burst 的第一块 PCM 开始打开，而不是等
  // VAD SpeechStart：极短/轻声词（比如"再见"）可能过不了本地 VAD，但 Deepgram 仍然能识别。
  let sttStream: SttStream | null = null;
  let sttAudioChunks: Buffer[] = [];
  const jobQueue: SpeakerJob[] = [];
  let draining = false;
  let decodedChunkCount = 0;
  let decodedBytes = 0;
  let lastDecodedAt: number | null = null;
  let audioWindowStartAt = Date.now();
  let audioWindowChunks = 0;
  let audioWindowBytes = 0;
  let audioWindowStats: PcmAudioStats = { sampleCount: 0, sumSquares: 0, peak: 0 };

  const logAudioDiagnostics = (reason: string, force = false) => {
    if (!AUDIO_DIAGNOSTICS_ENABLED) return;
    if (!force && Date.now() - audioWindowStartAt < AUDIO_DIAGNOSTICS_INTERVAL_MS) return;
    if (!force && audioWindowChunks === 0) return;

    const windowMs = Date.now() - audioWindowStartAt;
    const rms =
      audioWindowStats.sampleCount > 0 ? Math.sqrt(audioWindowStats.sumSquares / audioWindowStats.sampleCount) : 0;
    logger.info(
      {
        event: 'speaker_audio_diagnostics',
        guildId,
        userId,
        reason,
        decodedChunksTotal: decodedChunkCount,
        decodedBytesTotal: decodedBytes,
        lastDecodedAt,
        windowMs,
        windowChunks: audioWindowChunks,
        windowBytes: audioWindowBytes,
        rms: roundedLevel(rms),
        peak: roundedLevel(audioWindowStats.peak),
        sttStreamOpen: Boolean(sttStream),
        jobQueueLength: jobQueue.length,
      },
      `${userId} audio diagnostics: ${audioWindowChunks} PCM chunk(s), rms ${roundedLevel(rms)}, peak ${roundedLevel(audioWindowStats.peak)}`,
    );

    audioWindowStartAt = Date.now();
    audioWindowChunks = 0;
    audioWindowBytes = 0;
    audioWindowStats = { sampleCount: 0, sumSquares: 0, peak: 0 };
  };

  const observeDecodedPcmChunk = (chunk: Buffer) => {
    decodedChunkCount += 1;
    decodedBytes += chunk.length;
    lastDecodedAt = Date.now();
    audioWindowChunks += 1;
    audioWindowBytes += chunk.length;
    updatePcmAudioStats(audioWindowStats, chunk);
    logAudioDiagnostics('interval');
  };

  const openSttStreamIfNeeded = async (): Promise<void> => {
    if (sttStream) return;

    const session = await getSession(guildId);
    sttStream = openStream({
      language: session?.sourceLang,
      prompt: speakerState.lastTranscript,
      keyterms: getKeyterms(session?.game, session?.sourceLang),
    });
    sttAudioChunks = [];
  };

  const consumeSttAudioSegment = (): Float32Array | null => {
    if (sttAudioChunks.length === 0) return null;
    const stereoPcm = Buffer.concat(sttAudioChunks);
    sttAudioChunks = [];
    return stereoInt16BufferToMonoFloat32(stereoPcm);
  };

  // 关掉当前这路 STT 流（如果有）并拿到最终结果；没有正在进行的流就直接给个空结果，
  // 调用方（下面 handleDetectedSegment）后续会按"这段话没识别出文字"处理，不额外分支。
  // 流式连接在拿到最终结果之前中途失败（网络中断、供应商报错）时 stream.close() 的
  // promise 会 reject——这里捕获、记日志、返回 null，不做任何"退回旧的 pre-recorded
  // 方式重试"的兜底（见 DESIGN.md）。调用方把 null 原样传给 handleSegment，让
  // pipeline.js 已有的 try/finally + skipPlaybackSequence 分支去处理"这句话没有转写
  // 结果、直接跳过"这个情况，不在这里另写一套。
  const closeSttStream = async (): Promise<TranscribeResult | null> => {
    const stream = sttStream;
    sttStream = null;
    if (!stream) return { text: '' };
    try {
      return await stream.close();
    } catch (err) {
      logger.error({ err, userId }, `Streamed STT failed for a segment from ${userId}`);
      return null;
    }
  };

  const handleDetectedSegment = (segment: Float32Array, sequence: number, transcribeResult: TranscribeResult | null) => {
    const durationSec = (segment.length / 16000).toFixed(2);
    logger.info({ userId, durationSec }, `${userId} VAD determined the sentence ended, audio duration ${durationSec}s`);

    // wav 落盘只是旁路调试备份（见 recordings.ts 顶部注释），跟下面的转写结果处理/
    // 播放顺序分配并行、不 await——segment 是 VAD 输出的 16kHz 单声道音频，跟这句话
    // 走流式 STT 的那份 PCM 数据是同一份录音内容，只是备份走的是攒好的完整段，不是
    // 边到边的 chunk。备份写入失败只记日志，不能拖慢或中断转写/翻译/播放这条主链路。
    saveInputRecording(userId, Date.now(), segment, 16000).catch((err) => {
      logger.error({ err, userId }, `Failed to save backup input recording for ${userId}`);
    });

    handleSegment(guildId, connection, voiceChannel, userId, segment, speakerState, sequence, transcribeResult).catch((err) => {
      logger.error({ err, userId, sequence }, `Failed to process a voice segment for ${userId}`);
    });
  };

  // vad.feed()/forceEnd() 都会读写共享状态（VAD 的"是否在说话"标记、ONNX 模型的隐藏记忆），
  // 不能让它们并发重叠地跑，不然会互相踩踏，严重时会让底层 ONNX 推理卡死（实测踩过这个坑）。
  // 所以这里用跟 playback-queue.js 一样的"排队"模式，两种任务（音频块 / 强制结束）
  // 都进同一条队列，严格按顺序一个处理完再处理下一个。
  const drainJobQueue = async () => {
    if (draining) return;
    draining = true;

    while (jobQueue.length > 0) {
      const job = jobQueue.shift()!;
      try {
        if (job.type === 'chunk') {
          await openSttStreamIfNeeded();
          sttAudioChunks.push(job.data);
          const segments = await vad.feed(job.data, {
            onSpeechStart: () => {
              logger.info({ userId }, `${userId} VAD confirmed this is speech, starting to count a sentence`);
            },
          });
          // 说话过程中，decoder 吐出来的每一块 PCM 除了喂给 VAD 做边界判断，同时也
          // 原样边到边推给这路 STT 流——不等 VAD 判完整段，STT 全程跟着音频流并行转录。
          sttStream?.pushChunk(job.data);
          for (const segment of segments) {
            // 播放顺序号必须在这里、同步分配——这一刻（VAD 刚判定"这句话说完了"）
            // 就是它在整场会话里的实际先后顺序，不能等下面 closeSttStream() 这个异步
            // 网络调用完成之后再分配，那样分配到的是"STT 响应回来的顺序"，不同说话人
            // 的 STT 请求耗时不一，起不到重排的作用（见 playback-queue.js 顶部注释）。
            const sequence = await nextPlaybackSequence(guildId);
            const transcribeResult = await closeSttStream();
            sttAudioChunks = [];
            if (sequence === null) {
              // 理论上不会发生：这个说话人的处理流水线只会在 startListening 里
              // createSession 已经执行过之后才会启动，guild 会话此时必然存在。这里
              // 只是让 nextPlaybackSequence 的类型（number | null）跟这个运行时不变量
              // 对齐，不是新增了什么实际会走到的分支。
              logger.error({ userId }, `${userId} failed to allocate a playback sequence — guild session missing unexpectedly`);
              continue;
            }
            handleDetectedSegment(segment, sequence, transcribeResult);
          }
        } else if (job.type === 'forceEnd') {
          const segment = vad.forceEnd();
          if (segment) {
            logger.info({ userId }, `${userId} audio stream paused, force-ending this sentence`);
            const sequence = await nextPlaybackSequence(guildId);
            const transcribeResult = await closeSttStream();
            sttAudioChunks = [];
            if (sequence === null) {
              logger.error({ userId }, `${userId} failed to allocate a playback sequence — guild session missing unexpectedly`);
            } else {
              handleDetectedSegment(segment, sequence, transcribeResult);
            }
          } else if (sttStream) {
            logger.info(
              {
                event: 'speaker_force_end_without_vad_segment',
                guildId,
                userId,
                decodedChunksTotal: decodedChunkCount,
                decodedBytesTotal: decodedBytes,
                lastDecodedAt,
                sttStreamOpen: true,
              },
              `${userId} speaking ended without a complete VAD segment, closing open STT stream`,
            );
            // VAD 没有攒出一段完整语音，但这句话对应的 STT 流还开着——关掉，不留悬空连接。
            const fallbackSegment = consumeSttAudioSegment();
            const transcribeResult = await closeSttStream();
            const transcriptText = transcribeResult?.text?.trim();
            if (fallbackSegment && transcriptText) {
              const sequence = await nextPlaybackSequence(guildId);
              if (sequence === null) {
                logger.error({ userId }, `${userId} failed to allocate a playback sequence — guild session missing unexpectedly`);
              } else {
                logger.info(
                  { event: 'speaker_stt_fallback_without_vad_segment', guildId, userId, sequence, transcript: transcriptText },
                  `${userId} STT recognized text without a VAD segment, processing fallback segment`,
                );
                handleDetectedSegment(fallbackSegment, sequence, transcribeResult);
              }
            }
          } else {
            logger.info(
              {
                event: 'speaker_force_end_without_vad_segment',
                guildId,
                userId,
                decodedChunksTotal: decodedChunkCount,
                decodedBytesTotal: decodedBytes,
                lastDecodedAt,
                sttStreamOpen: false,
              },
              `${userId} speaking ended before VAD confirmed speech`,
            );
          }
        }
      } catch (err) {
        logger.error({ err, userId }, `Failed to process an audio task for ${userId}`);
      }
    }

    draining = false;
  };

  decoder.on('data', (chunk: Buffer) => {
    observeDecodedPcmChunk(chunk);
    jobQueue.push({ type: 'chunk', data: chunk });
    drainJobQueue();
  });

  // Discord 判定这个人音频流停了（收到 speaking 'end' 事件）时调用，见上面 onSpeakingEnd。
  speakerRuntime.forceEndSpeech = () => {
    logAudioDiagnostics('speaking_end', true);
    jobQueue.push({ type: 'forceEnd' });
    drainJobQueue();
  };

  opusStream.on('error', (err) => logger.error({ err, userId }, `Opus stream error for ${userId}`));
  decoder.on('error', (err) => logger.error({ err, userId }, `Decoder stream error for ${userId}`));

  guildRuntime.speakers.set(userId, speakerRuntime);
  logger.info(
    { event: 'speaker_pipeline_started', guildId, userId, who: speakerState.label },
    `Started listening to speaker ${userId}`,
  );
}
