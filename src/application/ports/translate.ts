import { translate as groqTranslate } from '../../adapter/out/groq/translate.js';
import { translate as deepseekTranslate } from '../../adapter/out/deepseek/translate.js';
import { createLogger } from '../../adapter/out/logger.js';

const logger = createLogger('ports/translate');

// 翻译端口：application 层只认这个文件，不直接 import 任何具体供应商的 adapter。
// 契约：translate(text: string, targetLang: string) => Promise<string>，
// 两个 provider 都要满足这个签名——新增供应商时在这里注册一行就行，不用碰 pipeline.js。
export type TranslateFn = (text: string, targetLang: string) => Promise<string>;

const PROVIDERS: Record<string, TranslateFn> = {
  groq: groqTranslate,
  deepseek: deepseekTranslate,
};

const PROVIDER_NAME = process.env.TRANSLATE_PROVIDER || 'groq';
const impl = PROVIDERS[PROVIDER_NAME];

if (!impl) {
  throw new Error(
    `Unknown TRANSLATE_PROVIDER: "${PROVIDER_NAME}", options: ${Object.keys(PROVIDERS).join(', ')}`,
  );
}

logger.info({ provider: PROVIDER_NAME }, `Translation provider: ${PROVIDER_NAME}`);

export function translate(text: string, targetLang: string): Promise<string> {
  return impl(text, targetLang);
}

export const activeProvider = PROVIDER_NAME;
