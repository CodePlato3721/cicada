// 用命名导入而不是默认导入——ioredis 的 default export 是从 Redis.js 转导出来的，
// 在这个项目的 moduleResolution:NodeNext 配置下，默认导入解析到的是整个模块命名空间
// 而不是 Redis 类本身，会报"不可构造"；命名导入 { Redis } 是 ioredis 自己文档里给
// ESM/NodeNext 场景推荐的写法。
import { Redis } from 'ioredis';
import { createLogger } from '../logger.js';
import { config } from '../../../config.js';

const logger = createLogger('redis/client');

// REDIS_URL 没配置就整个缓存层禁用（导出 null）——不会尝试连一个没人告诉过它的地址，
// 也不会因为连不上反复报错刷屏。翻译缓存是这个项目里第一个引入的"辅助功能，挂了不能
// 拖垮核心链路"的外部依赖（见 DESIGN.md「Redis unavailable fallback behavior」），
// adapter/out/redis/translate-cache.js 会在这个值是 null 时把所有读写当成"直接未命中/
// 直接跳过写"处理。
export const redisClient = config.redisUrl
  ? new Redis(config.redisUrl, {
      // 命令排队等重连没有意义——缓存查询本来就是"有则用、没有就走正常 LLM 翻译"，
      // 宁可命令立刻失败让调用方 catch 住降级，也不要因为 ioredis 默认的离线排队/
      // 无限重试拖慢当前这句话的翻译流水线（跟 CLAUDE.md「网络请求超时保护」里
      // fetchWithTimeout 的思路一致：不重试、快速失败）。
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: config.redisCommandTimeoutMs,
    })
  : null;

if (redisClient) {
  // ioredis 的 'error' 事件如果没有监听器，会变成未捕获异常直接崩进程——这里加监听器
  // 纯粹是为了兜底记录日志，不代表每次网络抖动/重连都会打印一条（ioredis 自己有重连
  // 逻辑，这里只负责"事件真的被发出来了"这件事本身不会拖垮进程）。
  redisClient.on('error', (err: Error) => logger.error({ err }, 'Redis connection error'));
} else {
  logger.warn('REDIS_URL not configured, translation cache layer disabled, all lookups will miss');
}
