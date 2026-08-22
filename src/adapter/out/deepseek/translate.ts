import { chatCompletion } from './client.js';
import { buildTranslationMessages } from '../../../domain/translation-prompt.js';
import type { TranslateOptions } from '../../../application/ports/translate.js';
import { createLogger } from '../logger.js';

const logger = createLogger('deepseek/translate');
const MODEL = 'deepseek-v4-flash';

// text: 待翻译原文。targetLang: ISO-639-1 代码（如 'en'）。
// 这个函数满足 application/ports/translate.js 定义的翻译端口签名，
// 跟 adapter/out/groq/translate.js 是同一个契约的两份实现，可以互换。
export async function translate(text: string, targetLang: string, options: TranslateOptions = {}): Promise<string> {
  const startedAt = Date.now();
  const completion = await chatCompletion({
    model: MODEL,
    temperature: 0,
    messages: buildTranslationMessages(text, targetLang),
  });

  const translatedText = completion.choices[0]?.message?.content?.trim() ?? '';
  logger.info(
    {
      event: 'external_api_usage',
      stage: 'llm',
      provider: 'deepseek',
      model: MODEL,
      ...options.logContext,
      elapsedMs: Date.now() - startedAt,
      inputTextChars: text.length,
      outputTextChars: translatedText.length,
      promptTokens: completion.usage?.prompt_tokens,
      completionTokens: completion.usage?.completion_tokens,
      totalTokens: completion.usage?.total_tokens,
      cachedPromptTokens: completion.usage?.prompt_tokens_details?.cached_tokens,
      reasoningTokens: completion.usage?.completion_tokens_details?.reasoning_tokens,
      usage: completion.usage,
    },
    'External API usage: LLM translation',
  );

  return translatedText;
}
