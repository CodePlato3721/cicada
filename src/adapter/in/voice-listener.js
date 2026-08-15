import { EndBehaviorType } from '@discordjs/voice';
import prism from 'prism-media';
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
} from '../../application/session.js';

// guildId -> { onSpeakingStart, onSpeakingEnd }：Discord 事件监听器的引用，只用于
// /leave 时能对称地 off() 掉。这是纯 adapter 细节，不属于业务状态，不放进 application/session.js。
const guildListeners = new Map();

export function startListening(connection, voiceChannel) {
  const guildId = connection.joinConfig.guildId;

  // 如果之前有残留状态（比如重复 /join），先清掉再重新开始。
  stopListening(guildId);

  createSession(guildId, connection, voiceChannel);

  const onSpeakingStart = (userId) => {
    // 诊断用：Discord 检测到这个人开始说话的时刻，跟 VAD 确认"这是人声"的时刻对比，
    // 能看出是不是网络/@discordjs-voice 这一层就已经有延迟。
    console.log(`[listener] ${userId} ${new Date().toLocaleTimeString()} Discord 检测到开始说话`);
    if (hasSpeaker(guildId, userId)) return; // 已经在监听这个人了
    createSpeakerPipeline(guildId, connection, userId).catch((err) => {
      console.error(`[listener] 初始化说话人 ${userId} 的监听失败：`, err);
    });
  };

  // Discord 客户端真正沉默时根本不发音频包，我们自己"数安静帧"的判断永远等不到帧，
  // 只能靠这个连接层面的信号强制收尾，不然一句话会跟很久之后的下一句无限粘在一起。
  const onSpeakingEnd = (userId) => {
    getSpeaker(guildId, userId)?.forceEndSpeech();
  };

  guildListeners.set(guildId, { onSpeakingStart, onSpeakingEnd });
  connection.receiver.speaking.on('start', onSpeakingStart);
  connection.receiver.speaking.on('end', onSpeakingEnd);

  console.log(`[listener] 已开始自动监听 guild ${guildId} 里的语音`);
}

export function stopListening(guildId) {
  const session = getSession(guildId);
  if (!session) return;

  const listeners = guildListeners.get(guildId);
  if (listeners) {
    session.connection.receiver.speaking.off('start', listeners.onSpeakingStart);
    session.connection.receiver.speaking.off('end', listeners.onSpeakingEnd);
    guildListeners.delete(guildId);
  }

  for (const speaker of listSpeakers(guildId)) {
    speaker.opusStream.destroy();
    speaker.decoder.destroy();
    speaker.vad.destroy().catch(() => {});
  }

  deleteSession(guildId);
  clearPlaybackQueue(guildId);
  console.log(`[listener] 已停止监听 guild ${guildId}`);
}

async function createSpeakerPipeline(guildId, connection, userId) {
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
  const speakerState = { vad, opusStream, decoder, lastTranscript: '' };

  const handleDetectedSegment = (segment) => {
    const durationSec = (segment.length / 16000).toFixed(2);
    console.log(`[listener] ${userId} ${new Date().toLocaleTimeString()} VAD 判定一句话结束，音频时长 ${durationSec}s`);
    handleSegment(guildId, connection, userId, segment, speakerState).catch((err) => {
      console.error(`[listener] 处理 ${userId} 的一段语音失败：`, err);
    });
  };

  // vad.feed()/forceEnd() 都会读写共享状态（VAD 的"是否在说话"标记、ONNX 模型的隐藏记忆），
  // 不能让它们并发重叠地跑，不然会互相踩踏，严重时会让底层 ONNX 推理卡死（实测踩过这个坑）。
  // 所以这里用跟 playback-queue.js 一样的"排队"模式，两种任务（音频块 / 强制结束）
  // 都进同一条队列，严格按顺序一个处理完再处理下一个。
  const jobQueue = [];
  let draining = false;

  const drainJobQueue = async () => {
    if (draining) return;
    draining = true;

    while (jobQueue.length > 0) {
      const job = jobQueue.shift();
      try {
        if (job.type === 'chunk') {
          const segments = await vad.feed(job.data, {
            onSpeechStart: () => {
              console.log(`[listener] ${userId} ${new Date().toLocaleTimeString()} VAD 确认这是人声，开始计入一句话`);
            },
          });
          for (const segment of segments) handleDetectedSegment(segment);
        } else if (job.type === 'forceEnd') {
          const segment = vad.forceEnd();
          if (segment) {
            console.log(`[listener] ${userId} ${new Date().toLocaleTimeString()} 音频流暂停，强制收尾这一句`);
            handleDetectedSegment(segment);
          }
        }
      } catch (err) {
        console.error(`[listener] 处理 ${userId} 的音频任务失败：`, err);
      }
    }

    draining = false;
  };

  decoder.on('data', (chunk) => {
    jobQueue.push({ type: 'chunk', data: chunk });
    drainJobQueue();
  });

  // Discord 判定这个人音频流停了（收到 speaking 'end' 事件）时调用，见上面 onSpeakingEnd。
  speakerState.forceEndSpeech = () => {
    jobQueue.push({ type: 'forceEnd' });
    drainJobQueue();
  };

  opusStream.on('error', (err) => console.error(`[listener] ${userId} 的 opus 流出错：`, err));
  decoder.on('error', (err) => console.error(`[listener] ${userId} 的解码流出错：`, err));

  addSpeaker(guildId, userId, speakerState);
  console.log(`[listener] 开始监听说话人 ${userId}`);
}
