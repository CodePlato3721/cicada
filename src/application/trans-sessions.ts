// trans_sessions 这一行的生命周期（open at /join, update mid-session, finalize at
// /leave）。billing 结算（finalizeSessionLedger，见 billing/billing-service.ts）和
// 对话素材采集（transcript_events 的 session 分组）现在共用同一张表——这个模块只管
// "session 开始/进行中更新"这两段，"结束时 update" 那段因为要顺带算费用，留在
// billing-service.ts 里（见那边 finalizeSessionLedger 的注释）。
import { dbPool } from '../adapter/out/db/client.js';
import { createLogger } from '../adapter/out/logger.js';
import { getSession, setTransSession } from './session.js';

const logger = createLogger('trans-sessions');

// /join 时调用（在 hydrateSessionBillingState 之后——依赖那一步已经 ensureAccount
// 把 guilds 行建好，才能查 transcript_retention_enabled）。无条件 insert 一行——
// billing 结算不看这个 guild 有没有开对话素材留存，两件事互不影响。
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

// /game、/config 切换游戏时调用——session 进行中场景可能变化，按最新值覆盖，不保留
// 历史（跟 Redis 里 session.game 是同一个"只存当前值"的模型）。没有 trans_sessions
// 行(比如还没 /join)就什么都不做。
export async function updateTransSessionGame(guildId: string, gameId: string): Promise<void> {
  const session = await getSession(guildId);
  if (!session?.transSessionId) return;

  await dbPool.query(`update trans_sessions set game_id = $2 where id = $1`, [session.transSessionId, gameId]);
}
