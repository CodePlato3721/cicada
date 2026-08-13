// Silero VAD 的推理封装。逻辑照搬自 @ricky0123/vad-node 内部的 Silero 类
// （它没有把这个类导出，只导出了整个 NonRealTimeVAD 批处理封装），
// 我们直接复用它随包自带的 onnx 模型文件，自己接 onnxruntime-node 跑推理，
// 这样才能拿到持久化的隐藏状态，用于真正的流式（而不是整段录完再分析）VAD。
import * as ort from 'onnxruntime-node';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const MODEL_PATH = join(dirname(require.resolve('@ricky0123/vad-node/package.json')), 'dist', 'silero_vad.onnx');

export class SileroSession {
  static async create() {
    const session = new SileroSession();
    await session.init();
    return session;
  }

  async init() {
    const modelBuffer = await readFile(MODEL_PATH);
    this._session = await ort.InferenceSession.create(modelBuffer);
    this._sr = new ort.Tensor('int64', [16000n]);
    this.resetState();
  }

  resetState() {
    const zeroes = new Array(2 * 64).fill(0);
    this._h = new ort.Tensor('float32', zeroes, [2, 1, 64]);
    this._c = new ort.Tensor('float32', zeroes, [2, 1, 64]);
  }

  // frame：单声道 16kHz Float32Array，长度需匹配 FrameProcessor 用的 frameSamples。
  async process(frame) {
    const input = new ort.Tensor('float32', frame, [1, frame.length]);
    const out = await this._session.run({ input, h: this._h, c: this._c, sr: this._sr });
    this._h = out.hn;
    this._c = out.cn;
    const [isSpeech] = out.output.data;
    return { isSpeech, notSpeech: 1 - isSpeech };
  }

  async dispose() {
    await this._session?.release?.();
  }
}
