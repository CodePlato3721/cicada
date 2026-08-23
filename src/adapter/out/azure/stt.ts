import wav from 'wav';
import type { OpenStreamFn, SttStream, TranscribeOptions, TranscribeResult } from '../../../application/ports/stt.js';
import { recognizeWav } from './client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('azure/stt');

const MODEL = 'conversation';
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BIT_DEPTH = 16;

const LANGUAGE_CODE_MAP: Record<string, string> = {
  zh: 'zh-TW',
  en: 'en-US',
  ko: 'ko-KR',
  ar: 'ar-SA',
};

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
    const language = this.options.language ? LANGUAGE_CODE_MAP[this.options.language] ?? this.options.language : undefined;

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
