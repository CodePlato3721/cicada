import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is not set — check your .env file`);
  }
  return value;
}

export const config = {
  // 语音链路阶段（STT/翻译/TTS）才会用到，先允许留空
  groqApiKey: process.env.GROQ_API_KEY,
  // 翻译供应商备用选项（TRANSLATE_PROVIDER=deepseek 时才需要），见 adapter/out/deepseek/
  deepseekApiKey: process.env.DEEPSEEK_API_KEY,
  // STT/TTS 供应商备用选项（STT_PROVIDER=deepgram 或 TTS 路由到 deepgram 时才需要）
  deepgramApiKey: process.env.DEEPGRAM_API_KEY,
  // TTS 供应商（zh/ko/pt/ar 目标语言路由到 azure 时才需要，见 ports/tts.js 的 TTS_PROVIDER_BY_LANG）
  azureSpeechKey: process.env.AZURE_SPEECH_KEY,
  azureSpeechRegion: process.env.AZURE_SPEECH_REGION,
  discordToken: required('DISCORD_BOT_TOKEN'),
  discordClientId: required('DISCORD_CLIENT_ID'),
  // 未设置时 deploy-commands 会报错提示，index.js 不强制依赖它
  testGuildId: process.env.DISCORD_TEST_GUILD_ID,
  // 翻译缓存层（目前只覆盖中文源语言，见 pipeline.js）。不设置就整个缓存层禁用，
  // 见 adapter/out/redis/client.js——不是必填项，Redis 不可用时直接走原有翻译流程。
  redisUrl: process.env.REDIS_URL,
  // 单条 Redis 命令的超时（毫秒）。缓存查询本来就该比一次 LLM 翻译快得多，超时应该
  // 设得比 API_TIMEOUT_MS 短——这里没有直接复用 API_TIMEOUT_MS，那个变量的定位是
  // "手写 fetch 调用"的超时（见 CLAUDE.md），Redis 走的是 ioredis 自己的
  // commandTimeout 机制，不是同一条链路。
  redisCommandTimeoutMs: Number(process.env.REDIS_COMMAND_TIMEOUT_MS) || 1000,
  // 翻译缓存条目的存活时间（秒），默认 3 天，见 DESIGN.md「Cache lifetime」——没有
  // 手动/事件驱动的失效机制，过期纯靠这个 TTL 自然淘汰。做成可配置是因为"多久算过时"
  // 本质上是运营层面的判断（黑话/版本更新频率变了，随时可能想调），不该改代码重新部署
  // 才能调整。
  redisCacheTtlSeconds: Number(process.env.TRANSLATE_CACHE_TTL_SECONDS) || 3 * 24 * 60 * 60,
  databaseUrl: required('DATABASE_URL'),
};
