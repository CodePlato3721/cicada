import { parseWav } from '../../domain/wav.js';
import type { UsageLogContext } from '../../application/ports/translate.js';
import type { ExternalApiUsage } from '../../application/billing/types.js';

export function wavDurationSec(buffer: Buffer): number | undefined {
  try {
    const { data, channels, sampleRate, bitsPerSample } = parseWav(buffer);
    const bytesPerSec = sampleRate * channels * (bitsPerSample / 8);
    // 空音频（比如供应商返回的 44 字节"空" WAV，channels=0/sampleRate=0/
    // bitsPerSample=0，见 CLAUDE.md「TTS 音色语言错配 bug」）会让 parseWav 不报错
    // 但分母算出 0——0/0 在 JS 里是 NaN，而 Postgres numeric 允许存字面量
    // 'NaN'，一旦插进 usage_events.quantity_audio_seconds，后续任何 sum() 统计
    // 都会被污染成 NaN（拿真实数据踩过一次，见 2026-08-22 测试）。跟 parseWav
    // 抛错时一样，返回 undefined 让上游按"没有这个数据"处理，不写脏值。
    if (bytesPerSec === 0) return undefined;
    return data.length / bytesPerSec;
  } catch {
    return undefined;
  }
}

export function buildTtsUsageFields({
  provider,
  model,
  voice,
  text,
  audio,
  elapsedMs,
  logContext,
}: {
  provider: string;
  model: string;
  voice?: string;
  text: string;
  audio: Buffer;
  elapsedMs: number;
  logContext?: UsageLogContext;
}): ExternalApiUsage & { event: 'external_api_usage' } {
  return {
    event: 'external_api_usage',
    stage: 'tts',
    provider,
    model,
    voice,
    ...logContext,
    elapsedMs,
    inputTextChars: text.length,
    audioBytes: audio.length,
    audioDurationSec: wavDurationSec(audio),
  };
}
