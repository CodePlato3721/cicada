import { config } from '../../../config.js';
import { fetchWithTimeout } from '../http.js';
import type { ChatMessage } from '../../../domain/translation-prompt.js';

const BASE_URL = 'https://api.deepseek.com';

export interface ChatCompletionParams {
  model: string;
  messages: ChatMessage[];
  temperature: number;
}

export interface ChatCompletionResponse {
  choices: Array<{ message: { content?: string | null } }>;
}

// DeepSeek 的 API 是 OpenAI 兼容的 REST 接口，这里没有额外装 SDK（openai/deepseek 官方包都没引入），
// 直接用 Node 自带的 fetch 调，减少依赖。跟 groq-sdk 那条链路实现方式不一样，
// 但对外的函数签名（chatCompletion 输入/输出）刻意保持跟 groq/client.js 类似的形状，方便对照。
export async function chatCompletion({ model, messages, temperature }: ChatCompletionParams): Promise<ChatCompletionResponse> {
  if (!config.deepseekApiKey) {
    throw new Error('DEEPSEEK_API_KEY is not set — check your .env file');
  }

  const response = await fetchWithTimeout(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.deepseekApiKey}`,
    },
    body: JSON.stringify({ model, messages, temperature }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`DeepSeek API request failed: ${response.status} ${response.statusText} ${errText}`);
  }

  return response.json() as Promise<ChatCompletionResponse>; // { choices: [{ message: { content } }], ... }，跟 OpenAI/Groq 的 chat completion 响应形状一致
}
