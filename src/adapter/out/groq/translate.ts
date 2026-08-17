import { getGroqClient } from './client.js';
import { buildTranslationMessages } from '../../../domain/translation-prompt.js';

// text: 待翻译原文。targetLang: ISO-639-1 代码（如 'en'）。
// 这个函数满足 application/ports/translate.js 定义的翻译端口签名——
// 换供应商时（见 adapter/out/deepseek/translate.js）要保持同样的签名和返回形状。
export async function translate(text: string, targetLang: string): Promise<string> {
  const groq = getGroqClient();

  const completion = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    temperature: 0,
    messages: buildTranslationMessages(text, targetLang),
  });

  return completion.choices[0]?.message?.content?.trim() ?? '';
}
