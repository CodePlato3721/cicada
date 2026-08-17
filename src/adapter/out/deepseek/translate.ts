import { chatCompletion } from './client.js';
import { buildTranslationMessages } from '../../../domain/translation-prompt.js';

// text: 待翻译原文。targetLang: ISO-639-1 代码（如 'en'）。
// 这个函数满足 application/ports/translate.js 定义的翻译端口签名，
// 跟 adapter/out/groq/translate.js 是同一个契约的两份实现，可以互换。
export async function translate(text: string, targetLang: string): Promise<string> {
  const completion = await chatCompletion({
    model: 'deepseek-v4-flash',
    temperature: 0,
    messages: buildTranslationMessages(text, targetLang),
  });

  return completion.choices[0]?.message?.content?.trim() ?? '';
}
