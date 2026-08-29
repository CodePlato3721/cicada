import { FrameProcessor, Message, Resampler } from '@ricky0123/vad-node';
import { SileroSession } from './silero.js';
import { stereoInt16BufferToMonoFloat32 } from './pcm.js';

const FRAME_SAMPLES = 1536;
const FRAME_DURATION_MS = (FRAME_SAMPLES / 16000) * 1000;

function silenceMsToRedemptionFrames(silenceMs: number): number {
  return Math.max(1, Math.round(silenceMs / FRAME_DURATION_MS));
}

export interface FeedOptions {
  onSpeechStart?: () => void;
}

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

  async feed(stereoBuffer: Buffer, { onSpeechStart }: FeedOptions = {}): Promise<Float32Array[]> {
    const mono = stereoInt16BufferToMonoFloat32(stereoBuffer);
    const segments: Float32Array[] = [];

    for (const frame of this.resampler.process(mono)) {
      const { msg, audio } = await this.frameProcessor.process(frame);
      if (msg === Message.SpeechStart) {
        onSpeechStart?.();
      }
      if (msg === Message.SpeechEnd && audio) {
        segments.push(audio);
      }
    }

    return segments;
  }

  forceEnd(): Float32Array | null {
    const { msg, audio } = this.frameProcessor.endSegment();
    return msg === Message.SpeechEnd && audio ? audio : null;
  }

  async destroy(): Promise<void> {
    await this.model.dispose();
  }
}
