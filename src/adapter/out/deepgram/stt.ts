import { config } from '../../../config.js';
import { createLogger } from '../logger.js';
import type { OpenStreamFn, SttStream, TranscribeOptions, TranscribeResult } from '../../../application/ports/stt.js';

const logger = createLogger('deepgram/stt');

const MODEL = 'nova-3';

// voice-listener.js 把 prism-media opus.Decoder 解码出来的原始 PCM 块（48kHz、双声道、
// 16-bit）边到边原样推过来，不做任何重采样/降混——这几个参数要如实告诉 Deepgram 这份
// 音频实际的编码格式，不是照抄 pre-recorded 时代 wav 文件（16kHz 单声道）的假设。
const ENCODING = 'linear16';
const SAMPLE_RATE = 48000;
const CHANNELS = 2;

// 跟 pre-recorded 时代（deepgram/stt.js 旧版）同一份映射：Deepgram 文档建议中文用
// 更具体的 zh-CN/zh-TW，这里固定用繁体（zh-TW）——理由见 CLAUDE.md「供应商可切换」
// 一节（项目排除中国大陆用户，中文用户以繁体为主，术语库译法也是繁体来源）。
const LANGUAGE_CODE_MAP: Record<string, string> = {
  zh: 'zh-TW',
};

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
    smart_format: 'true', // 自动加标点、数字格式化，转写结果更适合直接喂给翻译模型
    punctuate: 'true',
  });
  if (language) {
    params.set('language', LANGUAGE_CODE_MAP[language] ?? language);
  } else {
    params.set('detect_language', 'true');
  }
  // Deepgram keyterm prompting（nova-3）：keyterm 参数可以重复出现多次，每次一个词，
  // 不是逗号拼成一个字符串——用 URLSearchParams.append，不是 set。官方硬上限是 500
  // token（约 100 个词，见 https://developers.deepgram.com/docs/keyterm），调用方
  // （domain/keyterms.js 的 getKeyterms）已经按更保守的默认值截断过，这里不重复做
  // 上限校验，传多少个就加多少个。
  for (const term of keyterms ?? []) {
    params.append('keyterm', term);
  }
  return `wss://api.deepgram.com/v1/listen?${params}`;
}

// 一路 Deepgram 实时流式连接，对应"一句话"的生命周期：open 时建连，voice-listener.js
// 在这句话说话过程中把 PCM chunk 边到边推进来（pushChunk），VAD 判定这句话结束时
// 调用 close()：发 CloseStream 通知服务端结束、等服务端把最后的 is_final 结果发完、
// 连接关闭，再把攒好的转写文本 resolve 出去。
//
// 这次改动（TASK-01）范围内不加任何重试/重连——流式连接中途失败就让 close() 的
// promise 直接 reject，调用方自己决定怎么处理（对应 DESIGN.md：不退回 pre-recorded
// 方式兜底，直接判定这句话失败），这里不做额外兜底。
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

    // 浏览器/Node 全局 WebSocket 的标准 API 不支持自定义 header，Deepgram 官方文档
    // 给的替代方案是把 API key 通过 Sec-WebSocket-Protocol 子协议传过去（第二个参数
    // ['token', <key>]），不是 URL query 参数也不是自定义 header。
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
        return; // 不是 JSON（理论上不会发生），忽略
      }
      if (data.type !== 'Results') return;

      const transcript = data.channel?.alternatives?.[0]?.transcript ?? '';
      if (data.channel?.detected_language) {
        this.detectedLanguage = data.channel.detected_language;
      }
      // 只累积 is_final 的片段——interim 结果会被同一段音频后续的 is_final 结果取代，
      // 拼接 interim 内容会导致文本重复。一路连接对应一句话，理论上是一段连续语音，
      // 但 Deepgram 自己的 endpointing 仍可能把它切成多个 is_final 片段（比如中间有个
      // 短暂停顿），用空格拼起来。
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
          // detected_language 只有走自动检测（没传 language）时才会有；主动指定了
          // language 就直接把那个值透出去，效果一样是"这段话的语种是什么"，跟
          // pre-recorded 时代 deepgram/stt.js 的行为保持一致。
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
        // 还没主动 close() 就断了——直接判定这句话失败，不重连/不重试（TASK-01 范围）。
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
        // 连接没建立成功的话 close() 那边的 promise 已经在 reject 路径上了，
        // 这里只是不让这次 push 变成一个没人处理的 rejected promise。
        if (!this.pushOpenFailureLogged) {
          this.pushOpenFailureLogged = true;
          logger.error({ err }, 'Failed to push audio chunk to Deepgram streaming connection');
        }
      });
  }

  async close(): Promise<TranscribeResult> {
    this.closing = true;
    await this.opened.catch(() => {}); // 连接失败的话 closePromise 已经在 reject 路径上了
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'CloseStream' }));
    }
    return this.closePromise;
  }
}

export const openStream: OpenStreamFn = (options: TranscribeOptions = {}): SttStream => {
  return new DeepgramSttStream(options);
};
