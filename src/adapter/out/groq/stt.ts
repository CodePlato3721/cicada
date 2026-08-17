import { createReadStream } from 'node:fs';
import type { TranscribeOptions, TranscribeResult } from '../../../application/ports/stt.js';
import { getGroqClient } from './client.js';

// filePath: wav/mp3/... 音频文件路径。
// language 传 ISO-639-1 代码（如 'zh'）可以提升准确率和速度；不传则由模型自动检测语种。
// prompt 传上一段的识别结果可以给模型一点上下文，帮它在同音词/歧义词之间做出更合理的选择
// （比如"校车"和"笑车"读音完全一样，光靠这一小段音频本身有时候真的分不出来）。
export async function transcribe(filePath: string, { language, prompt }: TranscribeOptions = {}): Promise<TranscribeResult> {
  const groq = getGroqClient();

  const transcription = await groq.audio.transcriptions.create({
    file: createReadStream(filePath),
    model: 'whisper-large-v3-turbo',
    response_format: 'verbose_json',
    ...(language ? { language } : {}),
    ...(prompt ? { prompt } : {}),
  });

  // SDK 的 Transcription 类型只声明了 text 字段，但 response_format: 'verbose_json'
  // 实际响应还带 language/duration 等字段（SDK 类型没跟上 API 的完整返回形状）——
  // 显式取出 .text，language 按运行时实际形状读取，不用整个对象结构匹配 TranscribeResult。
  return { text: transcription.text, language: (transcription as { language?: string }).language };
}
