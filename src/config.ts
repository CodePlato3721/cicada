import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is not set — check your .env file`);
  }
  return value;
}

export const config = {
  groqApiKey: process.env.GROQ_API_KEY,
  deepseekApiKey: process.env.DEEPSEEK_API_KEY,
  openaiApiKey: process.env.OPENAI_API_KEY,
  deepgramApiKey: process.env.DEEPGRAM_API_KEY,
  azureSpeechKey: process.env.AZURE_SPEECH_KEY,
  azureSpeechRegion: process.env.AZURE_SPEECH_REGION,
  discordToken: required('DISCORD_BOT_TOKEN'),
  discordClientId: required('DISCORD_CLIENT_ID'),
  testGuildId: process.env.DISCORD_TEST_GUILD_ID,
  redisUrl: process.env.REDIS_URL,
  redisCommandTimeoutMs: Number(process.env.REDIS_COMMAND_TIMEOUT_MS) || 1000,
  redisCacheTtlSeconds: Number(process.env.TRANSLATE_CACHE_TTL_SECONDS) || 3 * 24 * 60 * 60,
  databaseUrl: required('DATABASE_URL'),
  eventsDir: required('EVENTS_DIR'),
};
