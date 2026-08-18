import { redisClient } from './client.js';
import { createLogger } from '../logger.js';
import { config } from '../../../config.js';

const logger = createLogger('redis/translate-cache');

// 查询失败（Redis 不可用/超时）就当作未命中处理，调用方（pipeline.js）据此直接走正常
// 翻译流程——不区分"真的没有这个 key"和"查询本身出错了"，调用方也不需要区分，见
// DESIGN.md「Redis unavailable fallback behavior」。
export async function getCachedTranslation(key: string): Promise<string | null> {
  if (!redisClient) return null;

  try {
    return await redisClient.get(key);
  } catch (err) {
    logger.error({ err, key }, 'Translation cache lookup failed, falling back to normal translation flow');
    return null;
  }
}

// 写入失败同样只是记日志、不抛出——对调用方来说，这句话本来就已经翻译完了，缓存没写
// 成功顶多是下次同样的话还得重新翻译一次，不影响这句话本身的播放。不重试（见
// client.js 的 maxRetriesPerRequest 注释，这里的 try/catch 是最后一道兜底）。
export async function setCachedTranslation(key: string, value: string): Promise<void> {
  if (!redisClient) return;

  try {
    await redisClient.set(key, value, 'EX', config.redisCacheTtlSeconds);
  } catch (err) {
    logger.error({ err, key }, 'Translation cache write failed, skipping cache for this sentence');
  }
}
