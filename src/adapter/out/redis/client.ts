import { Redis } from 'ioredis';
import { createLogger } from '../logger.js';
import { config } from '../../../config.js';

const logger = createLogger('redis/client');

if (!config.redisUrl) {
  throw new Error('Environment variable REDIS_URL is not set - Redis is required for session storage');
}

export const redisClient = new Redis(config.redisUrl, {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  commandTimeout: config.redisCommandTimeoutMs,
  connectTimeout: config.redisCommandTimeoutMs,
  retryStrategy: (times) => Math.min(times * 200, 5000),
});

redisClient.on('error', (err: Error) => logger.error({ err }, 'Redis connection error'));
redisClient.on('ready', () => logger.info('Redis connection (re)established'));

export async function ensureRedisReady(): Promise<void> {
  if (redisClient.status === 'wait' || redisClient.status === 'end') {
    await redisClient.connect();
  }
  await redisClient.ping();
}
