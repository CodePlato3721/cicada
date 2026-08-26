import { chatCompletion } from './client.js';
import { buildTranslationMessages } from '../../../domain/translation-prompt.js';
import type { TranslateOptions } from '../../../application/ports/translate.js';
import { createLogger } from '../logger.js';
import { recordExternalApiUsage } from '../../../application/billing/billing-service.js';

const logger = createLogger('openai/translate');
const MODEL = 'gpt-5-nano';

// text: 待翻译原文。targetLang: ISO-639-1 代码（如 'en'）。
// 这个函数满足 application/ports/translate.js 定义的翻译端口签名，
// 跟 adapter/out/groq/translate.js、adapter/out/deepseek/translate.js 是同一个契约的
// 三份实现，可以互换。
//
// reasoningEffort: 'minimal' —— gpt-5-nano 默认会做一定程度的内部推理，对这种一句话
// 翻译的任务没有必要、只会增加延迟（实时语音翻译链路对延迟敏感，见 CLAUDE.md）。
// 'minimal' 基本等同于关掉推理，跟 deepseek 那边 `thinking: { type: 'disabled' }`
// 是同一个目的、不同供应商各自的参数名。
export async function translate(text: string, targetLang: string, options: TranslateOptions = {}): Promise<string> {
  const startedAt = Date.now();
  const completion = await chatCompletion({
    model: MODEL,
    reasoningEffort: 'minimal',
    messages: buildTranslationMessages(text, targetLang),
  });

  const translatedText = completion.choices[0]?.message?.content?.trim() ?? '';
  const usageLog = {
      event: 'external_api_usage',
      stage: 'llm',
      provider: 'openai',
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
