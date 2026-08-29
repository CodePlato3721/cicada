import * as ort from 'onnxruntime-node';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';

export interface SpeechProbabilities {
  isSpeech: number;
  notSpeech: number;
}

const require = createRequire(import.meta.url);
const MODEL_PATH = join(dirname(require.resolve('@ricky0123/vad-node/package.json')), 'dist', 'silero_vad.onnx');

export class SileroSession {
  private _session!: ort.InferenceSession;
  private _sr!: ort.Tensor;
  private _h!: ort.Tensor;
  private _c!: ort.Tensor;

  static async create(): Promise<SileroSession> {
    const session = new SileroSession();
    await session.init();
    return session;
  }

  async init(): Promise<void> {
    const modelBuffer = await readFile(MODEL_PATH);
    this._session = await ort.InferenceSession.create(modelBuffer);
    this._sr = new ort.Tensor('int64', [16000n]);
    this.resetState();
  }

  resetState(): void {
    const zeroes = new Array(2 * 64).fill(0);
    this._h = new ort.Tensor('float32', zeroes, [2, 1, 64]);
    this._c = new ort.Tensor('float32', zeroes, [2, 1, 64]);
  }

  async process(frame: Float32Array): Promise<SpeechProbabilities> {
    const input = new ort.Tensor('float32', frame, [1, frame.length]);
    const out = await this._session.run({ input, h: this._h, c: this._c, sr: this._sr });
    this._h = out.hn as ort.Tensor;
    this._c = out.cn as ort.Tensor;
    const [isSpeech] = out.output.data as Float32Array;
    return { isSpeech, notSpeech: 1 - isSpeech };
  }

  async dispose(): Promise<void> {
    await this._session?.release?.();
  }
}
