import type { SynthesizeOptions, VoicesByGender } from '../../../application/ports/tts.js';
import { postJsonForAudio } from './client.js';
import { createLogger } from '../logger.js';
import { buildTtsUsageFields } from '../usage-log.js';
import { recordExternalApiUsage } from '../../../application/billing/billing-service.js';
import voiceCatalog from '../../../config/tts-voices-deepgram.json' with { type: 'json' };

const logger = createLogger('deepgram/tts');

export const VOICES_BY_LANG_AND_GENDER: Record<string, VoicesByGender> = voiceCatalog;

export const VALID_VOICES: string[] = Object.values(VOICES_BY_LANG_AND_GENDER).flatMap((byGender) => [
  ...(byGender.male ?? []),
  ...(byGender.female ?? []),
]);

export const TTS_SUPPORTED_LANGS = ['en', 'es', 'de', 'fr', 'ja', 'nl', 'it'];

export async function synthesize(
  text: string,
  { voice = 'aura-2-thalia-en', logContext }: SynthesizeOptions = { voice: 'aura-2-thalia-en' },
): Promise<Buffer> {
  if (!VALID_VOICES.includes(voice)) {
    throw new Error(`voice must be one of: ${VALID_VOICES.join(', ')}`);
  }

  const params = new URLSearchParams({
    model: voice,
    encoding: 'linear16',
    container: 'wav',
    sample_rate: '24000',
  });

  const startedAt = Date.now();
  const audio = await postJsonForAudio(`/speak?${params}`, { text });
  const usageLog = buildTtsUsageFields({
    provider: 'deepgram',
    model: 'aura-2',
    voice,
    text,
    audio,
    elapsedMs: Date.now() - startedAt,
    logContext,
  });
  logger.info(usageLog, 'External API usage: TTS synthesis');
  await recordExternalApiUsage(usageLog);
  return audio;
}
