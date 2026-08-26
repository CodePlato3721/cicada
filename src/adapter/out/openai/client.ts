import { config } from '../../../config.js';
import { fetchWithTimeout } from '../http.js';
import type { ChatMessage } from '../../../domain/translation-prompt.js';

const BASE_URL = 'https://api.openai.com/v1';

export interface ChatCompletionParams {
  model: string;
  messages: ChatMessage[];
  // gpt-5 系列是推理模型（跟 o1/o3 同一类），Chat Completions 接口不接受自定义
  // temperature——传非默认值（比如 deepseek/groq 那边惯用的 0）会直接被 API 拒绝
  // （400: "Only the default (1) value is supported"），所以这里干脆不暴露 temperature
  // 参数，调用方也不用传。控制"要不要多想"的旋钮换成了 reasoningEffort。
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
}

export interface ChatCompletionResponse {
  choices: Array<{ message: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      [key: string]: unknown;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
}

// OpenAI 官方 SDK 没引入——跟 deepseek/client.js 同一个理由，这条链路就是个 OpenAI 兼容的
// REST 接口，直接 fetch 调，函数签名也刻意保持跟 deepseek/client.js、groq/client.js
// 类似的形状，方便对照。
export async function chatCompletion({ model, messages, reasoningEffort }: ChatCompletionParams): Promise<ChatCompletionResponse> {
  if (!config.openaiApiKey) {
    throw new Error('OPENAI_API_KEY is not set — check your .env file');
  }

  const response = await fetchWithTimeout(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openaiApiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`OpenAI API request failed: ${response.status} ${response.statusText} ${errText}`);
  }

  return response.json() as Promise<ChatCompletionResponse>; // { choices: [{ message: { content } }], ... }，跟 Groq/DeepSeek 的 chat completion 响应形状一致
}
