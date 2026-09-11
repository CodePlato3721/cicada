import { redisClient } from './client.js';
import { config } from '../../../config.js';

// Redis 现在是 session 存储的必需依赖（见 client.ts），不再是"可有可无的缓存"，
// 这里不再判空、不再吞错误——跟 session.ts 的 redisClient 调用同一个政策：出错直接
// 往上抛，让调用方（pipeline.ts）的这一句话处理失败，而不是悄悄当成 cache miss 继续
// 走正常翻译流程掩盖 Redis 故障。

export async function getCachedTranslation(key: string): Promise<string | null> {
  return redisClient.get(key);
}

export async function setCachedTranslation(key: string, value: string): Promise<void> {
  await redisClient.set(key, value, 'EX', config.redisCacheTtlSeconds);
}
