import wav from 'wav';
import Groq from 'groq-sdk';
import type { OpenStreamFn, SttStream, TranscribeOptions, TranscribeResult } from '../../../application/ports/stt.js';
import { getGroqClient } from './client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('groq/stt');

// voice-listener.js 边到边推过来的 PCM chunk 跟 deepgram/stt.ts 假设的格式一致：
// prism-media opus.Decoder 解码出来的原始 PCM（48kHz、双声道、16-bit），不做任何
// 重采样/降混。
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BIT_DEPTH = 16;

// Groq 当前不是实际启用的供应商（.env 里 STT_PROVIDER=deepgram），按 DESIGN.md 的说明
// 这里不需要实现真正的流式——对外符合 TASK-01 定的流式端口契约（pushChunk 边推、close
// 时 resolve 最终结果），内部只是把推进来的 PCM chunk 攒起来，等 close() 时一次性
// 打包成 wav、调旧的 pre-recorded Whisper 接口（groq.audio.transcriptions.create），
// 把结果当"流式的最终结果"返回。调用方（voice-listener.js）不需要区分当前
// STT_PROVIDER 是 deepgram 还是 groq，两边对外行为一致；只是 groq 这一路完全没有
// "边说边转录"的延时收益，等一整句攒完才发一次请求，跟改造前的 pre-recorded 行为
// 没有本质区别。
class GroqSttStream implements SttStream {
  private chunks: Buffer[] = [];
  private options: TranscribeOptions;

  constructor(options: TranscribeOptions = {}) {
    this.options = options;
  }

  pushChunk(chunk: Buffer): void {
    this.chunks.push(chunk);
  }

  async close(): Promise<TranscribeResult> {
    const pcm = Buffer.concat(this.chunks);
    const wavBuffer = await encodeWav(pcm);

    const groq = getGroqClient();
    const transcription = await groq.audio.transcriptions.create({
      file: await Groq.toFile(wavBuffer, 'segment.wav', { type: 'audio/wav' }),
      model: 'whisper-large-v3-turbo',
      response_format: 'verbose_json',
      ...(this.options.language ? { language: this.options.language } : {}),
      ...(this.options.prompt ? { prompt: this.options.prompt } : {}),
    });

    // SDK 的 Transcription 类型只声明了 text 字段，但 response_format: 'verbose_json'
    // 实际响应还带 language/duration 等字段（SDK 类型没跟上 API 的完整返回形状）——
    // 显式取出 .text，language 按运行时实际形状读取，不用整个对象结构匹配 TranscribeResult
    // （跟迁移前的 pre-recorded transcribe() 处理方式一致，见 typescript-migration 规则）。
    return { text: transcription.text, language: (transcription as { language?: string }).language };
  }
}

// 把整句攒好的原始 PCM 包成一个带合法 WAV 头的 Buffer——Whisper 的
// pre-recorded 接口认的是完整音频文件（flac/mp3/wav/...），不认没有容器格式的裸 PCM。
// 复用 recordings.ts 已经在用的同一个 `wav` 包，只是这里不落盘，直接在内存里收集
// Writer（Transform 流）吐出来的 chunk 拼成一个 Buffer。
function encodeWav(pcm: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const writer = new wav.Writer({ sampleRate: SAMPLE_RATE, channels: CHANNELS, bitDepth: BIT_DEPTH });
    const chunks: Buffer[] = [];
    writer.on('data', (chunk: Buffer) => chunks.push(chunk));
    writer.on('end', () => resolve(Buffer.concat(chunks)));
    writer.on('error', reject);
    writer.end(pcm);
  });
}

export const openStream: OpenStreamFn = (options: TranscribeOptions = {}): SttStream => {
  logger.info({}, 'Opening a Groq STT "stream" — actually buffers the whole segment, only sends it once close() is called');
  return new GroqSttStream(options);
};
