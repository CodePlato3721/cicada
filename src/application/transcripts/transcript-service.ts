import { dbPool } from '../../adapter/out/db/client.js';

export interface TranscriptEventInput {
  guildId: string;
  sessionId: string;
  userId: string;
  sequence: number;
  gameId: string | undefined;
  sourceLang: string;
  targetLang: string;
  transcriptText: string;
  translatedText: string;
  termHitCount: number;
  cacheHit: boolean;
}

export async function recordTranscriptEvent(input: TranscriptEventInput): Promise<void> {
  await dbPool.query(
    `
      insert into transcript_events (
        session_id, guild_id, user_id, sequence, game_id, source_lang, target_lang,
        transcript_text, translated_text, term_hit_count, cache_hit
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `,
    [
      input.sessionId,
      input.guildId,
      input.userId,
      input.sequence,
      input.gameId ?? null,
      input.sourceLang,
      input.targetLang,
      input.transcriptText,
      input.translatedText,
      input.termHitCount,
      input.cacheHit,
    ],
  );
}
