import { readFile } from 'node:fs/promises';
import type { TranscribeOptions, TranscribeResult } from '../../../application/ports/stt.js';
import { postBinary } from './client.js';

const MODEL = 'nova-3'; // Pre-Recorded 档，价格/接口都跟这个项目现在的用法（存好文件再转录）匹配

// Deepgram 文档里中文推荐用更具体的 zh-CN/zh-TW，而不是裸的 zh，这里做个映射；
// 没列出的语言代码原样传过去。
// 用 zh-TW（繁体）不是 zh-CN：CLAUDE.md 里产品定位明确排除中国大陆（Discord 在那边
// 打不开），实际中文用户以繁体为主（台湾/香港/海外华人），术语库里抓的英雄名译法
// 也是繁体 wiki 来源，两边要对得上，不然术语检测会因为简繁字形不一致而匹配不到。
const LANGUAGE_CODE_MAP: Record<string, string> = {
  zh: 'zh-TW',
};

interface DeepgramTranscriptionResponse {
  results?: {
    channels?: Array<{
      alternatives?: Array<{ transcript?: string }>;
      detected_language?: string;
    }>;
  };
}

// filePath: wav 文件路径。language 传 BCP-47/ISO 代码（如 'zh'/'en'）可以提升准确率；
// 不传就用 Deepgram 的自动检测（multi 系模型），此时额外传 detect_language=true
// 让响应里带上实际识别到的语种，供上层锁定这个说话人的源语言（术语库检测要用）。
// prompt（上一句识别结果，帮同音词消歧）：Deepgram 没有对应参数，接了但不用，
// 跟 groq/stt.js 保持同样的调用签名，方便端口两边随时互换。
export async function transcribe(filePath: string, { language, prompt }: TranscribeOptions = {}): Promise<TranscribeResult> {
  void prompt; // 见上面注释：接了但不用，保持跟 groq/stt.js 一致的签名
  const audioBuffer = await readFile(filePath);

  const params = new URLSearchParams({
    model: MODEL,
    smart_format: 'true', // 自动加标点、数字格式化，转写结果更适合直接喂给翻译模型
    punctuate: 'true',
  });
  if (language) {
    params.set('language', LANGUAGE_CODE_MAP[language] ?? language);
  } else {
    params.set('detect_language', 'true');
  }

  const result = await postBinary<DeepgramTranscriptionResponse>(`/listen?${params}`, audioBuffer, 'audio/wav');

  const channel = result.results?.channels?.[0];
  const text = channel?.alternatives?.[0]?.transcript ?? '';
  // detected_language 只有在没传 language（走自动检测）时才会有；主动指定了 language
  // 就直接把那个值透出去，效果一样是"这段话的语种是什么"，上层不用关心是猜的还是指定的。
  const detectedLanguage = language ?? channel?.detected_language;
  // 跟 groq/stt.js 的返回形状对齐（{ text, language, ... }），pipeline.js 目前只取 .text，
  // 术语库检测（terminology.js）会用到 .language。
  return { text, language: detectedLanguage };
}
