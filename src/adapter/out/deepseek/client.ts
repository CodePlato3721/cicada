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
    body: JSON.stringify({ model, messages, temperature, thinking: { type: 'disabled' } }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`DeepSeek API request failed: ${response.status} ${response.statusText} ${errText}`);
  }

  return response.json() as Promise<ChatCompletionResponse>;
}
