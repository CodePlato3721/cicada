import type { SynthesizeOptions, VoicesByGender } from '../../../application/ports/tts.js';
import { synthesizeSsml } from './client.js';
import { createLogger } from '../logger.js';
import { buildTtsUsageFields } from '../usage-log.js';
import { recordExternalApiUsage } from '../../../application/billing/billing-service.js';
import voiceCatalog from '../../../config/tts-voices-azure.json' with { type: 'json' };

const logger = createLogger('azure/tts');

export const VOICES_BY_LANG_AND_GENDER: Record<string, VoicesByGender> = voiceCatalog;

export const VALID_VOICES: string[] = Object.values(VOICES_BY_LANG_AND_GENDER).flatMap((byGender) => [
  ...(byGender.male ?? []),
  ...(byGender.female ?? []),
]);

export const TTS_SUPPORTED_LANGS = ['en', 'fr', 'ja', 'de', 'es', 'zh', 'ko', 'pt', 'ar'];

function localeFromVoiceName(voice: string): string {
  const [lang, region] = voice.split('-');
  return `${lang}-${region}`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function synthesize(text: string, { voice, logContext }: SynthesizeOptions): Promise<Buffer> {
  if (!VALID_VOICES.includes(voice)) {
    throw new Error(`voice must be one of: ${VALID_VOICES.join(', ')}`);
  }

  const locale = localeFromVoiceName(voice);
  const ssml = `<speak version='1.0' xml:lang='${locale}'><voice xml:lang='${locale}' name='${voice}'>${escapeXml(text)}</voice></speak>`;

  const startedAt = Date.now();
  const audio = await synthesizeSsml(ssml);
  const usageLog = buildTtsUsageFields({
    provider: 'azure',
    model: 'neural',
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
