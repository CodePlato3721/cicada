import { getGroqClient } from './client.js';
import { buildTranslationMessages } from '../../../domain/translation-prompt.js';
import type { TranslateOptions } from '../../../application/ports/translate.js';
import { createLogger } from '../logger.js';
import { recordExternalApiUsage } from '../../../application/billing/billing-service.js';

const logger = createLogger('groq/translate');
const MODEL = 'llama-3.1-8b-instant';

// text: 待翻译原文。targetLang: ISO-639-1 代码（如 'en'）。
// 这个函数满足 application/ports/translate.js 定义的翻译端口签名——
// 换供应商时（见 adapter/out/deepseek/translate.js）要保持同样的签名和返回形状。
export async function translate(text: string, targetLang: string, options: TranslateOptions = {}): Promise<string> {
  const startedAt = Date.now();
  const groq = getGroqClient();

  const completion = await groq.chat.completions.create({
    model: MODEL,
    temperature: 0,
    messages: buildTranslationMessages(text, targetLang),
  });

  const translatedText = completion.choices[0]?.message?.content?.trim() ?? '';
  const usageLog = {
      event: 'external_api_usage',
      stage: 'llm',
      provider: 'groq',
      model: MODEL,
      ...options.logContext,
      elapsedMs: Date.now() - startedAt,
      inputTextChars: text.length,
      outputTextChars: translatedText.length,
      promptTokens: completion.usage?.prompt_tokens,
      completionTokens: completion.usage?.completion_tokens,
      totalTokens: completion.usage?.total_tokens,
      usage: completion.usage,
    } as const;
  logger.info(usageLog, 'External API usage: LLM translation');
  await recordExternalApiUsage(usageLog);

  return translatedText;
}
