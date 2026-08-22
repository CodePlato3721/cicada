import { Pool } from 'pg';
import { config } from '../../../config.js';
import { createLogger } from '../logger.js';

const logger = createLogger('db/client');

export const dbPool = new Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.DATABASE_POOL_MAX) || 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

dbPool.on('error', (err: Error) => logger.error({ err }, 'Postgres pool error'));

export async function ensureDatabaseReady(): Promise<void> {
  await dbPool.query('select 1');
}

