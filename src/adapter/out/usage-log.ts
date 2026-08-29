import { parseWav } from '../../domain/wav.js';
import type { UsageLogContext } from '../../application/ports/translate.js';
import type { ExternalApiUsage } from '../../application/billing/types.js';

export function wavDurationSec(buffer: Buffer): number | undefined {
  try {
    const { data, channels, sampleRate, bitsPerSample } = parseWav(buffer);
    const bytesPerSec = sampleRate * channels * (bitsPerSample / 8);
    if (bytesPerSec === 0) return undefined;
    return data.length / bytesPerSec;
  } catch {
    return undefined;
  }
}

export function buildTtsUsageFields({
  provider,
  model,
  voice,
  text,
  audio,
  elapsedMs,
  logContext,
}: {
  provider: string;
  model: string;
  voice?: string;
  text: string;
  audio: Buffer;
  elapsedMs: number;
  logContext?: UsageLogContext;
}): ExternalApiUsage & { event: 'external_api_usage' } {
  return {
    event: 'external_api_usage',
    stage: 'tts',
    provider,
    model,
    voice,
    ...logContext,
    elapsedMs,
    inputTextChars: text.length,
    audioBytes: audio.length,
    audioDurationSec: wavDurationSec(audio),
  };
}
