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
  // 断线后台后台无限重连，等待时间随失败次数线性增长、封顶 5s——这只负责让底层连接自己
  // 恢复，不代表断线期间发出的命令会被排队等重连（enableOfflineQueue: false 已经保证
  // 那些命令照样立刻失败），调用方该报错还是报错，翻译该失败还是失败。
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
