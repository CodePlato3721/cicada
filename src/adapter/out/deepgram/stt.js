import { readFile } from 'node:fs/promises';
import { postBinary } from './client.js';

const MODEL = 'nova-3'; // Pre-Recorded 档，价格/接口都跟这个项目现在的用法（存好文件再转录）匹配

// Deepgram 文档里中文推荐用更具体的 zh-CN/zh-TW，而不是裸的 zh，这里做个映射；
// 没列出的语言代码原样传过去。
const LANGUAGE_CODE_MAP = {
  zh: 'zh-CN',
};

// filePath: wav 文件路径。language 传 BCP-47/ISO 代码（如 'zh'/'en'）可以提升准确率；
// 不传就用 Deepgram 的自动检测（multi 系模型）。
// prompt（上一句识别结果，帮同音词消歧）：Deepgram 没有对应参数，接了但不用，
// 跟 groq/stt.js 保持同样的调用签名，方便端口两边随时互换。
export async function transcribe(filePath, { language, prompt } = {}) {
  const audioBuffer = await readFile(filePath);

  const params = new URLSearchParams({
    model: MODEL,
    smart_format: 'true', // 自动加标点、数字格式化，转写结果更适合直接喂给翻译模型
    punctuate: 'true',
  });
  if (language) params.set('language', LANGUAGE_CODE_MAP[language] ?? language);

  const result = await postBinary(`/listen?${params}`, audioBuffer, 'audio/wav');

  const text = result.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
  return { text }; // 跟 groq/stt.js 的返回形状对齐（pipeline.js 只用得到 .text）
}
