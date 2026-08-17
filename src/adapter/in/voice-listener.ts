import { EndBehaviorType, type VoiceConnection, type AudioReceiveStream } from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import prism from 'prism-media';
import type { opus } from 'prism-media';
import { StreamingVad } from '../../domain/streaming-vad.js';
import { clearPlaybackQueue } from '../out/playback-queue.js';
import { handleSegment } from '../../application/pipeline.js';
import {
  createSession,
  getSession,
  deleteSession,
  addSpeaker,
  getSpeaker,
  hasSpeaker,
  listSpeakers,
  nextPlaybackSequence,
  type SpeakerState,
} from '../../application/session.js';
import { createLogger } from '../out/logger.js';

const logger = createLogger('listener');

// 这个说话人 pipeline 自己构造、只有这个文件会读写的字段（vad/opusStream/decoder/
// forceEndSpeech）——session.ts 的 SpeakerState 只声明了 application 层关心的那几个
// 字段（见 session.ts 顶部注释：这些是"还没转 TS 的 voice-listener.js 构造并挂上去的
// Discord/VAD 相关字段"），具体类型留给这里（唯一构造它们的地方）自己维护，不回头改
// session.ts 的 SpeakerState 定义。
interface ListenerSpeakerState extends SpeakerState {
  vad: StreamingVad;
  opusStream: AudioReceiveStream;
  decoder: opus.Decoder;
  // 占位后立即被 createSpeakerPipeline 里的真实实现覆盖（见下方），字段本身必须在
  // 对象字面量构造时就存在，不能是可选——forceEndSpeech() 会被 onSpeakingEnd 直接调用，
  // 不想每次调用都做一次"存在与否"的可选链判断。
  forceEndSpeech: () => void;
}

// guildId -> { onSpeakingStart, onSpeakingEnd }：Discord 事件监听器的引用，只用于
// /leave 时能对称地 off() 掉。这是纯 adapter 细节，不属于业务状态，不放进 application/session.js。
interface GuildListeners {
  onSpeakingStart: (userId: string) => void;
  onSpeakingEnd: (userId: string) => void;
}

const guildListeners = new Map<string, GuildListeners>();

export function startListening(connection: VoiceConnection, voiceChannel: VoiceBasedChannel): void {
  const guildId = connection.joinConfig.guildId;

  // 如果之前有残留状态（比如重复 /join），先清掉再重新开始。
  stopListening(guildId);

  createSession(guildId, connection, voiceChannel);

  const onSpeakingStart = (userId: string) => {
    // 诊断用：Discord 检测到这个人开始说话的时刻，跟 VAD 确认"这是人声"的时刻对比，
    // 能看出是不是网络/@discordjs-voice 这一层就已经有延迟——两条日志各自的 time 字段
    // 就是时间点，不用再在消息文本里手动拼一遍时间。
    logger.info({ userId }, `${userId} Discord detected speaking started`);
    if (hasSpeaker(guildId, userId)) return; // 已经在监听这个人了
    createSpeakerPipeline(guildId, connection, userId).catch((err) => {
      logger.error({ err, userId }, `Failed to initialize listening for speaker ${userId}`);
    });
  };

  // Discord 客户端真正沉默时根本不发音频包，我们自己"数安静帧"的判断永远等不到帧，
  // 只能靠这个连接层面的信号强制收尾，不然一句话会跟很久之后的下一句无限粘在一起。
  const onSpeakingEnd = (userId: string) => {
    (getSpeaker(guildId, userId) as ListenerSpeakerState | undefined)?.forceEndSpeech();
  };

  guildListeners.set(guildId, { onSpeakingStart, onSpeakingEnd });
  connection.receiver.speaking.on('start', onSpeakingStart);
  connection.receiver.speaking.on('end', onSpeakingEnd);

  logger.info({ guildId }, `Started auto-listening to voice in guild ${guildId}`);
}

export function stopListening(guildId: string): void {
  const session = getSession(guildId);
  if (!session) return;

  const listeners = guildListeners.get(guildId);
  if (listeners) {
    session.connection.receiver.speaking.off('start', listeners.onSpeakingStart);
    session.connection.receiver.speaking.off('end', listeners.onSpeakingEnd);
    guildListeners.delete(guildId);
  }

  for (const speaker of listSpeakers(guildId)) {
    const listenerSpeaker = speaker as ListenerSpeakerState;
    listenerSpeaker.opusStream.destroy();
    listenerSpeaker.decoder.destroy();
    listenerSpeaker.vad.destroy().catch(() => {});
  }

  deleteSession(guildId);
  clearPlaybackQueue(guildId);
  logger.info({ guildId }, `Stopped listening to guild ${guildId}`);
}

// jobQueue 里排队的两种任务：一块新到的音频（chunk）或者"强制结束这句话"（forceEnd）。
type SpeakerJob = { type: 'chunk'; data: Buffer } | { type: 'forceEnd' };

async function createSpeakerPipeline(guildId: string, connection: VoiceConnection, userId: string): Promise<void> {
  const vad = await StreamingVad.create();

  // Manual：不自动结束订阅，我们自己控制生命周期（/leave 时统一清理）。
  // "一句话说完没"完全交给上面的 VAD 实时判断，不再依赖 Discord 自带的静音计时。
  const opusStream = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.Manual },
  });
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });

  opusStream.pipe(decoder);

  // lastTranscript：这个人上一句话识别出来的文字，作为下一句 STT 的上下文提示，
  // 帮模型在同音词/歧义词之间做出更符合语境的选择（比如"校车"和"笑车"读音完全一样）。
  // forceEndSpeech 先占位，下面 jobQueue/drainJobQueue 定义好之后立即被替换成真正实现
  // （跟原来的构造顺序一致：先有 speakerState，再补上依赖 jobQueue 闭包的那个字段）。
  const speakerState: ListenerSpeakerState = {
    vad,
    opusStream,
    decoder,
    lastTranscript: '',
    forceEndSpeech: () => {},
  };

  const handleDetectedSegment = (segment: Float32Array) => {
    const durationSec = (segment.length / 16000).toFixed(2);
    logger.info({ userId, durationSec }, `${userId} VAD determined the sentence ended, audio duration ${durationSec}s`);
    // 播放顺序号必须在这里、同步分配——这一刻就是"这句话真正说完"的时刻，代表它在
    // 整场会话里的实际先后顺序。不能等 handleSegment 异步处理完再分配，那样分配到的
    // 是"处理完的顺序"，STT/翻译并发跑、处理快慢不一，起不到重排的作用（见
    // playback-queue.js 顶部注释）。
    const sequence = nextPlaybackSequence(guildId);
    if (sequence === null) {
      // 理论上不会发生：这个说话人的处理流水线只会在 startListening 里 createSession
      // 已经执行过之后才会启动（见上面 startListening 的调用顺序），guild 会话此时
      // 必然存在。这里只是让 nextPlaybackSequence 的类型（number | null）跟这个运行时
      // 不变量对齐，不是新增了什么实际会走到的分支。
      logger.error({ userId }, `${userId} failed to allocate a playback sequence — guild session missing unexpectedly`);
      return;
    }
    handleSegment(guildId, connection, userId, segment, speakerState, sequence).catch((err) => {
      logger.error({ err, userId, sequence }, `Failed to process a voice segment for ${userId}`);
    });
  };

  // vad.feed()/forceEnd() 都会读写共享状态（VAD 的"是否在说话"标记、ONNX 模型的隐藏记忆），
  // 不能让它们并发重叠地跑，不然会互相踩踏，严重时会让底层 ONNX 推理卡死（实测踩过这个坑）。
  // 所以这里用跟 playback-queue.js 一样的"排队"模式，两种任务（音频块 / 强制结束）
  // 都进同一条队列，严格按顺序一个处理完再处理下一个。
  const jobQueue: SpeakerJob[] = [];
  let draining = false;

  const drainJobQueue = async () => {
    if (draining) return;
    draining = true;

    while (jobQueue.length > 0) {
      const job = jobQueue.shift()!;
      try {
        if (job.type === 'chunk') {
          const segments = await vad.feed(job.data, {
            onSpeechStart: () => {
              logger.info({ userId }, `${userId} VAD confirmed this is speech, starting to count a sentence`);
            },
          });
          for (const segment of segments) handleDetectedSegment(segment);
        } else if (job.type === 'forceEnd') {
          const segment = vad.forceEnd();
          if (segment) {
            logger.info({ userId }, `${userId} audio stream paused, force-ending this sentence`);
            handleDetectedSegment(segment);
          }
        }
      } catch (err) {
        logger.error({ err, userId }, `Failed to process an audio task for ${userId}`);
      }
    }

    draining = false;
  };

  decoder.on('data', (chunk: Buffer) => {
    jobQueue.push({ type: 'chunk', data: chunk });
    drainJobQueue();
  });

  // Discord 判定这个人音频流停了（收到 speaking 'end' 事件）时调用，见上面 onSpeakingEnd。
  speakerState.forceEndSpeech = () => {
    jobQueue.push({ type: 'forceEnd' });
    drainJobQueue();
  };

  opusStream.on('error', (err) => logger.error({ err, userId }, `Opus stream error for ${userId}`));
  decoder.on('error', (err) => logger.error({ err, userId }, `Decoder stream error for ${userId}`));

  addSpeaker(guildId, userId, speakerState);
  logger.info({ userId }, `Started listening to speaker ${userId}`);
}
