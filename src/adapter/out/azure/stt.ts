import wav from 'wav';
import type { OpenStreamFn, SttStream, TranscribeOptions, TranscribeResult } from '../../../application/ports/stt.js';
import { recognizeWav } from './client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('azure/stt');

const MODEL = 'conversation';
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BIT_DEPTH = 16;

class AzureSttStream implements SttStream {
  private chunks: Buffer[] = [];
  private options: TranscribeOptions;

  constructor(options: TranscribeOptions = {}) {
    this.options = options;
  }

  pushChunk(chunk: Buffer): void {
    this.chunks.push(chunk);
  }

  async close(): Promise<TranscribeResult> {
    const startedAt = Date.now();
    const pcm = Buffer.concat(this.chunks);
    // 2026-08-26 起 options.language 直接是具体 locale（如 'zh-TW'/'en-US'，见
    // ports/stt.js 的 SUPPORTED_SOURCE_LANGS，这份列表照抄自 Deepgram 官方支持的
    // locale 全集），原样透传——不再需要一张"基础码 → 具体 locale"的映射表。这份
    // locale 集合是按 Deepgram 的格式给的，不保证每一个都精确匹配 Azure 自己的
    // locale 命名（两家大部分重合，个别生僻地区变体可能对不上），但 Azure 目前是
    // 未启用的备用供应商（STT_PROVIDER=deepgram），没必要为一个用不到的供应商去
    // 精确核对它自己的 locale 列表，真要切回 Azure 时再核实调整。
    const language = this.options.language;

    if (!language) {
      logger.warn(
        { provider: 'azure', model: MODEL, audioBytes: pcm.length, chunkCount: this.chunks.length },
        'Azure STT skipped because source language is not configured',
      );
      return {
        text: '',
        usage: {
          provider: 'azure',
          model: MODEL,
          audioDurationSec: pcm.length / (SAMPLE_RATE * CHANNELS * (BIT_DEPTH / 8)),
          audioBytes: pcm.length,
          chunkCount: this.chunks.length,
          elapsedMs: Date.now() - startedAt,
        },
      };
    }

    const wavBuffer = await encodeWav(pcm);
    const result = await recognizeWav(wavBuffer, language);
    const text = result.DisplayText ?? '';

    return {
      text,
      language,
      usage: {
        provider: 'azure',
        model: MODEL,
        audioDurationSec: pcm.length / (SAMPLE_RATE * CHANNELS * (BIT_DEPTH / 8)),
        audioBytes: pcm.length,
        chunkCount: this.chunks.length,
        elapsedMs: Date.now() - startedAt,
      },
    };
  }
}

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
  logger.info({}, 'Opening an Azure STT stream - buffers the whole segment and sends it once close() is called');
  return new AzureSttStream(options);
};
