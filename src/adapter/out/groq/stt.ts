import wav from 'wav';
import Groq from 'groq-sdk';
import type { OpenStreamFn, SttStream, TranscribeOptions, TranscribeResult } from '../../../application/ports/stt.js';
import { getGroqClient } from './client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('groq/stt');

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BIT_DEPTH = 16;

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
    const startedAt = Date.now();
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

    return {
      text: transcription.text,
      language: (transcription as { language?: string }).language,
      usage: {
        provider: 'groq',
        model: 'whisper-large-v3-turbo',
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
  logger.info({}, 'Opening a Groq STT "stream" — actually buffers the whole segment, only sends it once close() is called');
  return new GroqSttStream(options);
};
