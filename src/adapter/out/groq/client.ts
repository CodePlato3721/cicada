import Groq from 'groq-sdk';
import { config } from '../../../config.js';

let client: Groq | undefined;

// SDK 默认 timeout 是 1 分钟、超时/网络错误会自动重试 2 次——对实时语音链路来说太宽松了，
// 慢请求会悄悄拖很久才失败，跟 deepseek/deepgram 那边手动加的超时保护统一到同一个量级
// （见 adapter/out/http.js 的说明：踩过 34 秒卡死不报错的坑）。
// maxRetries 降到 1：网络抖动值得重试一次，但不想因为重试把最坏情况拖到 3 倍超时时长。
export function getGroqClient(): Groq {
  if (!client) {
    if (!config.groqApiKey) {
      throw new Error('GROQ_API_KEY is not set — check your .env file');
    }
    client = new Groq({
      apiKey: config.groqApiKey,
      timeout: Number(process.env.API_TIMEOUT_MS ?? 5000),
      maxRetries: 1,
    });
  }
  return client;
}
