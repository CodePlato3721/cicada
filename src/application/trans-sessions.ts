import { dbPool } from '../adapter/out/db/client.js';
import { createLogger } from '../adapter/out/logger.js';
import { getSession, setTransSession } from './session.js';

const logger = createLogger('trans-sessions');

export async function openTransSession(guildId: string): Promise<void> {
  const guildResult = await dbPool.query<{ transcript_retention_enabled: boolean }>(
    `select transcript_retention_enabled from guilds where guild_id = $1`,
    [guildId],
  );
  const transcriptRetentionEnabled = guildResult.rows[0]?.transcript_retention_enabled ?? false;

  const inserted = await dbPool.query<{ id: string }>(
    `insert into trans_sessions (guild_id, session_started_at) values ($1, now()) returning id`,
    [guildId],
  );
  const transSessionId = inserted.rows[0].id;
  await setTransSession(guildId, transSessionId, transcriptRetentionEnabled);
  logger.info(
    { guildId, transSessionId, transcriptRetentionEnabled },
    `guild ${guildId} trans session ${transSessionId} opened (transcript retention: ${transcriptRetentionEnabled})`,
  );
}

export async function updateTransSessionGame(guildId: string, gameId: string): Promise<void> {
  const session = await getSession(guildId);
  if (!session?.transSessionId) return;

  await dbPool.query(`update trans_sessions set game_id = $2 where id = $1`, [session.transSessionId, gameId]);
}
