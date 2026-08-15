import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`环境变量 ${name} 未设置，请检查 .env 文件`);
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
};
