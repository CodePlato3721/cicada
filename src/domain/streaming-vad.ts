import { FrameProcessor, Message, Resampler } from '@ricky0123/vad-node';
import { SileroSession } from './silero.js';
import { stereoInt16BufferToMonoFloat32 } from './pcm.js';

const FRAME_SAMPLES = 1536; // Silero 推荐帧长之一，@16kHz ≈ 96ms/帧
const FRAME_DURATION_MS = (FRAME_SAMPLES / 16000) * 1000;

// 静音判定阈值——按 CLAUDE.md 要求做成可调参数，不硬编码。
// 阈值过短 → 容易把自然停顿误判为句子结束；过长 → 增加延迟。
function silenceMsToRedemptionFrames(silenceMs: number): number {
  return Math.max(1, Math.round(silenceMs / FRAME_DURATION_MS));
}

export interface FeedOptions {
  // 诊断用的可选回调，VAD 概率刚越过阈值、判定"开始说话"的那一帧触发，
  // 用来定位"从开口到 VAD 确认"之间是不是有延迟。
  onSpeechStart?: () => void;
}

// 每个说话人一份独立实例：VAD 的 LSTM 隐藏状态和"是否在说话"这些状态不能跨人共用，
// 不然多人同时说话会互相污染判断。resampler 和 frameProcessor 也是持久化的，
// 跨多次 feed() 调用维持状态，音频流之间不会在边界丢采样点。
export class StreamingVad {
  private model: SileroSession;
  private frameProcessor: FrameProcessor;
  private resampler: Resampler;

  static async create(): Promise<StreamingVad> {
    const model = await SileroSession.create();
    const silenceMs = Number(process.env.VAD_SILENCE_MS ?? 500);

    const frameProcessor = new FrameProcessor(
      (frame) => model.process(frame),
      () => model.resetState(),
      {
        frameSamples: FRAME_SAMPLES,
        positiveSpeechThreshold: Number(process.env.VAD_POSITIVE_THRESHOLD ?? 0.5),
        negativeSpeechThreshold: Number(process.env.VAD_NEGATIVE_THRESHOLD ?? 0.35),
        redemptionFrames: silenceMsToRedemptionFrames(silenceMs),
        preSpeechPadFrames: 1,
        minSpeechFrames: Number(process.env.VAD_MIN_SPEECH_FRAMES ?? 3),
        submitUserSpeechOnPause: false,
      },
    );
    frameProcessor.resume();

    const resampler = new Resampler({
      nativeSampleRate: 48000,
      targetSampleRate: 16000,
      targetFrameSize: FRAME_SAMPLES,
    });

    return new StreamingVad(model, frameProcessor, resampler);
  }

  constructor(model: SileroSession, frameProcessor: FrameProcessor, resampler: Resampler) {
    this.model = model;
    this.frameProcessor = frameProcessor;
    this.resampler = resampler;
  }

  // stereoBuffer：48kHz 立体声 16-bit PCM 的一小块（比如一次 Opus 解码回调的量）。
  // 返回这次调用里新检测到的完整语音段（通常是空数组，偶尔有 1 个）。
  async feed(stereoBuffer: Buffer, { onSpeechStart }: FeedOptions = {}): Promise<Float32Array[]> {
    const mono = stereoInt16BufferToMonoFloat32(stereoBuffer);
    const segments: Float32Array[] = [];

    for (const frame of this.resampler.process(mono)) {
      const { msg, audio } = await this.frameProcessor.process(frame);
      if (msg === Message.SpeechStart) {
        onSpeechStart?.();
      }
      if (msg === Message.SpeechEnd && audio) {
        segments.push(audio); // Float32Array，16kHz 单声道
      }
    }

    return segments;
  }

  // 强制结束当前正在累积的语音段，不等静音帧计数达标。
  // 用途：Discord 客户端在真正沉默时根本不发音频包（语音活动检测/DTX），这种情况下
  // 我们自己基于"数够 N 帧安静"的判断永远等不到帧，只能靠外部信号（连接层面的
  // "这个人不说话了"事件）来强制收尾，不然一句话会跟下一句无限粘在一起。
  // 调用方要保证不会跟 feed() 并发执行（两者都改 frameProcessor 的共享状态）。
  forceEnd(): Float32Array | null {
    const { msg, audio } = this.frameProcessor.endSegment();
    return msg === Message.SpeechEnd && audio ? audio : null;
  }

  async destroy(): Promise<void> {
    await this.model.dispose();
  }
}
