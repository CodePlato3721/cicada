import { config } from '../../../config.js';
import { createLogger } from '../logger.js';
import type { OpenStreamFn, SttStream, TranscribeOptions, TranscribeResult } from '../../../application/ports/stt.js';

const logger = createLogger('deepgram/stt');

const MODEL = 'nova-3';

const ENCODING = 'linear16';
const SAMPLE_RATE = 48000;
const CHANNELS = 2;

interface DeepgramStreamingMessage {
  type?: string;
  is_final?: boolean;
  channel?: {
    alternatives?: Array<{ transcript?: string }>;
    detected_language?: string;
  };
}

function describeWebSocketError(event: Event): Record<string, unknown> {
  const errorEvent = event as ErrorEvent & { error?: unknown };
  const err = errorEvent.error;
  return {
    eventType: event.type,
    message: errorEvent.message,
    errorName: err instanceof Error ? err.name : undefined,
    errorMessage: err instanceof Error ? err.message : undefined,
  };
}

function buildUrl({ language, keyterms }: TranscribeOptions): string {
  const params = new URLSearchParams({
    model: MODEL,
    encoding: ENCODING,
    sample_rate: String(SAMPLE_RATE),
    channels: String(CHANNELS),
    smart_format: 'true',
    punctuate: 'true',
  });
  if (language) {
    params.set('language', language);
  } else {
    params.set('detect_language', 'true');
  }
  for (const term of keyterms ?? []) {
    params.append('keyterm', term);
  }
  return `wss://api.deepgram.com/v1/listen?${params}`;
}

class DeepgramSttStream implements SttStream {
  private ws: WebSocket;
  private opened: Promise<void>;
  private finalTranscript = '';
  private detectedLanguage: string | undefined;
  private requestedLanguage: string | undefined;
  private startedAt = Date.now();
  private audioBytes = 0;
  private chunkCount = 0;
  private keytermCount = 0;
  private openFailed = false;
  private pushOpenFailureLogged = false;
  private closeSettled = false;
  private closing = false;
  private closePromise: Promise<TranscribeResult>;
  private settleClose!: (result: TranscribeResult) => void;
  private failClose!: (err: Error) => void;

  constructor(options: TranscribeOptions = {}) {
    if (!config.deepgramApiKey) {
      throw new Error('DEEPGRAM_API_KEY is not set — check your .env file');
    }

    this.requestedLanguage = options.language;
    this.keytermCount = options.keyterms?.length ?? 0;

    this.closePromise = new Promise<TranscribeResult>((resolve, reject) => {
      this.settleClose = resolve;
      this.failClose = reject;
    });
    this.closePromise.catch(() => {});

    this.ws = new WebSocket(buildUrl(options), ['token', config.deepgramApiKey]);

    this.opened = new Promise<void>((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener(
        'error',
        (event) => {
          const errorInfo = describeWebSocketError(event);
          const err = new Error(
            `Deepgram streaming connection failed to open (${[
              errorInfo.message,
              errorInfo.errorName,
              errorInfo.errorMessage,
            ]
              .filter(Boolean)
              .join('; ') || 'no detail from WebSocket runtime'})`,
          );
          this.openFailed = true;
          logger.error(
            {
              err,
              provider: 'deepgram',
              model: MODEL,
            requestedLanguage: this.requestedLanguage,
              keytermCount: this.keytermCount,
              errorInfo,
            },
            'Deepgram streaming connection failed to open',
          );
          this.rejectClose(err);
          reject(err);
        },
        { once: true },
      );
    });

    this.ws.addEventListener('message', (event: MessageEvent) => {
      let data: DeepgramStreamingMessage;
      try {
        data = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (data.type !== 'Results') return;

      const transcript = data.channel?.alternatives?.[0]?.transcript ?? '';
      if (data.channel?.detected_language) {
        this.detectedLanguage = data.channel.detected_language;
      }
      if (data.is_final && transcript) {
        this.finalTranscript = this.finalTranscript ? `${this.finalTranscript} ${transcript}` : transcript;
      }
    });

    this.ws.addEventListener('error', () => {
      this.rejectClose(new Error('Deepgram streaming connection error'));
    });

    this.ws.addEventListener('close', (event: CloseEvent) => {
      if (this.closing) {
        this.resolveClose({
          text: this.finalTranscript,
          language: this.detectedLanguage ?? this.requestedLanguage,
          usage: {
            provider: 'deepgram',
            model: MODEL,
            audioDurationSec: this.audioBytes / (SAMPLE_RATE * CHANNELS * 2),
            audioBytes: this.audioBytes,
            chunkCount: this.chunkCount,
            keytermCount: this.keytermCount,
            elapsedMs: Date.now() - this.startedAt,
          },
        });
      } else if (!event.wasClean) {
        const err = new Error(`Deepgram streaming connection closed unexpectedly (code ${event.code}, reason: ${event.reason || 'none'})`);
        logger.error(
          {
            err,
            provider: 'deepgram',
            model: MODEL,
            requestedLanguage: this.requestedLanguage,
            closeCode: event.code,
            closeReason: event.reason || undefined,
            closeWasClean: event.wasClean,
          },
          'Deepgram streaming connection closed unexpectedly',
        );
        this.rejectClose(err);
      }
    });
  }

  private resolveClose(result: TranscribeResult): void {
    if (this.closeSettled) return;
    this.closeSettled = true;
    this.settleClose(result);
  }

  private rejectClose(err: Error): void {
    if (this.closeSettled) return;
    this.closeSettled = true;
    this.failClose(err);
  }

  pushChunk(chunk: Buffer): void {
    this.audioBytes += chunk.length;
    this.chunkCount += 1;
    if (this.openFailed) {
      if (!this.pushOpenFailureLogged) {
        this.pushOpenFailureLogged = true;
        logger.error(
          { provider: 'deepgram', model: MODEL, requestedLanguage: this.requestedLanguage },
          'Dropping audio chunks because Deepgram streaming connection failed to open',
        );
      }
      return;
    }
    this.opened
      .then(() => {
        if (this.ws.readyState === WebSocket.OPEN) this.ws.send(chunk);
      })
      .catch((err: unknown) => {
        if (!this.pushOpenFailureLogged) {
          this.pushOpenFailureLogged = true;
          logger.error({ err }, 'Failed to push audio chunk to Deepgram streaming connection');
        }
      });
  }

  async close(): Promise<TranscribeResult> {
    this.closing = true;
    await this.opened.catch(() => {});
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'CloseStream' }));
    }
    return this.closePromise;
  }
}

export const openStream: OpenStreamFn = (options: TranscribeOptions = {}): SttStream => {
  return new DeepgramSttStream(options);
};
