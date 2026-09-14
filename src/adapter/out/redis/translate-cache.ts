import { redisClient } from './client.js';
import { config } from '../../../config.js';

export async function getCachedTranslation(key: string): Promise<string | null> {
  return redisClient.get(key);
}

export async function setCachedTranslation(key: string, value: string): Promise<void> {
  await redisClient.set(key, value, 'EX', config.redisCacheTtlSeconds);
}
