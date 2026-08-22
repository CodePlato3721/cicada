import { parseWav } from '../../domain/wav.js';
import type { UsageLogContext } from '../../application/ports/translate.js';

export function wavDurationSec(buffer: Buffer): number | undefined {
  try {
    const { data, channels, sampleRate, bitsPerSample } = parseWav(buffer);
    return data.length / (sampleRate * channels * (bitsPerSample / 8));
  } catch {
    return undefined;
  }
}

export function buildTtsUsageFields({
  provider,
  model,
  text,
  audio,
  elapsedMs,
  logContext,
}: {
  provider: string;
  model: string;
  text: string;
  audio: Buffer;
  elapsedMs: number;
  logContext?: UsageLogContext;
}): Record<string, unknown> {
  return {
    event: 'external_api_usage',
    stage: 'tts',
    provider,
    model,
    ...logContext,
    elapsedMs,
    inputTextChars: text.length,
    audioBytes: audio.length,
    audioDurationSec: wavDurationSec(audio),
  };
}
