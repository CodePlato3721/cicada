import { chatCompletion } from './client.js';
import { buildTranslationMessages } from '../../../domain/translation-prompt.js';
import type { TranslateOptions } from '../../../application/ports/translate.js';
import { createLogger } from '../logger.js';
import { recordExternalApiUsage } from '../../../application/billing/billing-service.js';

const logger = createLogger('deepseek/translate');
const MODEL = 'deepseek-v4-flash';

export async function translate(text: string, targetLang: string, options: TranslateOptions = {}): Promise<string> {
  const startedAt = Date.now();
  const completion = await chatCompletion({
    model: MODEL,
    temperature: 0,
    messages: buildTranslationMessages(text, targetLang),
  });

  const translatedText = completion.choices[0]?.message?.content?.trim() ?? '';
  const usageLog = {
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
    } as const;
  logger.info(usageLog, 'External API usage: LLM translation');
  await recordExternalApiUsage(usageLog);

  return translatedText;
}
