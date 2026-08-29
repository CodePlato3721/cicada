import { redisClient } from './client.js';
import { createLogger } from '../logger.js';
import { config } from '../../../config.js';

const logger = createLogger('redis/translate-cache');

export async function getCachedTranslation(key: string): Promise<string | null> {
  if (!redisClient) return null;

  try {
    return await redisClient.get(key);
  } catch (err) {
    logger.error({ err, key }, 'Translation cache lookup failed, falling back to normal translation flow');
    return null;
  }
}

export async function setCachedTranslation(key: string, value: string): Promise<void> {
  if (!redisClient) return;

  try {
    await redisClient.set(key, value, 'EX', config.redisCacheTtlSeconds);
  } catch (err) {
    logger.error({ err, key }, 'Translation cache write failed, skipping cache for this sentence');
  }
}
