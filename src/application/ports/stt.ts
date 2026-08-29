import { openStream as deepgramOpenStream } from '../../adapter/out/deepgram/stt.js';
import { openStream as groqOpenStream } from '../../adapter/out/groq/stt.js';
import { openStream as azureOpenStream } from '../../adapter/out/azure/stt.js';
import sttProviderConfig from '../../config/stt-providers.json' with { type: 'json' };

export interface TranscribeOptions {
  language?: string;
  prompt?: string;
  keyterms?: string[];
}

export interface TranscribeResult {
  text: string;
  language?: string;
  usage?: {
    provider: string;
    model: string;
    audioDurationSec?: number;
    audioBytes?: number;
    chunkCount?: number;
    keytermCount?: number;
    elapsedMs?: number;
  };
  [key: string]: unknown;
}

export interface SttStream {
  pushChunk(chunk: Buffer): void;
  close(): Promise<TranscribeResult>;
}

export type OpenStreamFn = (options?: TranscribeOptions) => SttStream;

const PROVIDERS: Record<string, OpenStreamFn> = {
  azure: azureOpenStream,
  deepgram: deepgramOpenStream,
  groq: groqOpenStream,
};

const STT_PROVIDER_BY_LANG: Record<string, string> = sttProviderConfig.sttProviders;

const DEFAULT_PROVIDER = 'deepgram';

export function resolveSttProvider(language: string | undefined): string {
  if (!language) return DEFAULT_PROVIDER;
  return STT_PROVIDER_BY_LANG[language] ?? DEFAULT_PROVIDER;
}

export function openStream(options: TranscribeOptions = {}): SttStream {
  const providerName = resolveSttProvider(options.language);
  const impl = PROVIDERS[providerName];
  if (!impl) {
    throw new Error(`Unknown STT provider: "${providerName}", options: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  return impl(options);
}

export const SUPPORTED_SOURCE_LANGS = Object.keys(STT_PROVIDER_BY_LANG);
