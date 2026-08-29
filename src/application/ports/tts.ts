import * as groq from '../../adapter/out/groq/tts.js';
import * as deepgram from '../../adapter/out/deepgram/tts.js';
import * as azure from '../../adapter/out/azure/tts.js';
import type { UsageLogContext } from './translate.js';
import ttsProviderConfig from '../../config/tts-providers.json' with { type: 'json' };

export interface VoicesByGender {
  male?: string[];
  female?: string[];
}

export interface SynthesizeOptions {
  voice: string;
  targetLang?: string;
  logContext?: UsageLogContext;
}

export interface TtsProviderModule {
  synthesize(text: string, options: SynthesizeOptions): Promise<Buffer>;
  VOICES_BY_LANG_AND_GENDER: Record<string, VoicesByGender>;
}

const PROVIDERS: Record<string, TtsProviderModule> = { groq, deepgram, azure };

export const TTS_PROVIDER_BY_LANG: Record<string, string> = ttsProviderConfig.ttsProviders;

export const SUPPORTED_TARGET_LANGS = Object.keys(TTS_PROVIDER_BY_LANG);

export function resolveTtsProvider(targetLang: string): string | undefined {
  return TTS_PROVIDER_BY_LANG[targetLang];
}

export interface SynthesizeParams {
  voice: string;
  targetLang?: string;
  provider: string;
  logContext?: UsageLogContext;
}

export function synthesize(text: string, { voice, targetLang, provider, logContext }: SynthesizeParams): Promise<Buffer> {
  const impl = PROVIDERS[provider];
  if (!impl) {
    throw new Error(`Unknown TTS provider: "${provider}", options: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  return impl.synthesize(text, { voice, targetLang, logContext });
}

export function getVoicesByGender(provider: string, lang: string): VoicesByGender {
  return PROVIDERS[provider]?.VOICES_BY_LANG_AND_GENDER?.[lang] ?? {};
}

export const PROVIDER_NAMES = Object.keys(PROVIDERS);
