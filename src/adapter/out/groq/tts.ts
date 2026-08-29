import type { SynthesizeOptions, VoicesByGender } from '../../../application/ports/tts.js';
import { getGroqClient } from './client.js';
import { createLogger } from '../logger.js';
import { buildTtsUsageFields } from '../usage-log.js';
import { recordExternalApiUsage } from '../../../application/billing/billing-service.js';

const logger = createLogger('groq/tts');
const MODEL = 'canopylabs/orpheus-v1-english';

export const VOICES_BY_LANG_AND_GENDER: Record<string, VoicesByGender> = {
  en: { male: ['austin', 'daniel', 'troy'], female: ['diana', 'hannah', 'autumn'] },
  ar: { male: ['austin', 'daniel', 'troy'], female: ['diana', 'hannah', 'autumn'] },
};

export const VALID_VOICES: string[] = [
  ...new Set(
    Object.values(VOICES_BY_LANG_AND_GENDER).flatMap((byGender) => [...(byGender.male ?? []), ...(byGender.female ?? [])]),
  ),
];

export const TTS_SUPPORTED_LANGS = ['en', 'ar'];

export async function synthesize(
  text: string,
  { voice = 'autumn', logContext }: SynthesizeOptions = { voice: 'autumn' },
): Promise<Buffer> {
  if (!VALID_VOICES.includes(voice)) {
    throw new Error(`voice must be one of: ${VALID_VOICES.join(', ')}`);
  }

  const groq = getGroqClient();

  const startedAt = Date.now();
  const response = await groq.audio.speech.create({
    input: text,
    model: MODEL,
    voice,
    response_format: 'wav',
  });

  const audio = Buffer.from(await response.arrayBuffer());
  const usageLog = buildTtsUsageFields({
    provider: 'groq',
    model: MODEL,
    text,
    audio,
    elapsedMs: Date.now() - startedAt,
    logContext,
  });
  logger.debug(usageLog, 'External API usage: TTS synthesis');
  await recordExternalApiUsage(usageLog);
  return audio;
}
