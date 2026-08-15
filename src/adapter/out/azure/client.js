import { config } from '../../../config.js';
import { fetchWithTimeout } from '../http.js';

// Azure Speech 的 REST 端点是"每个 region 一个域名"，不是像 Groq/DeepSeek/Deepgram
// 那样固定一个 base URL——region 来自 AZURE_SPEECH_REGION（控制台"密钥和终结点"页面
// 能看到，比如 eastus）。
function baseUrl() {
  if (!config.azureSpeechRegion) {
    throw new Error('AZURE_SPEECH_REGION 未设置，请检查 .env 文件');
  }
  return `https://${config.azureSpeechRegion}.tts.speech.microsoft.com`;
}

// 鉴权用 Ocp-Apim-Subscription-Key 请求头直接带资源密钥——官方文档确认这个方式对
// text-to-speech 有效，不需要像 Bearer token 那套流程一样先换取、10 分钟就过期的
// access token，少一层状态要维护。
//
// ssml: 完整的 SSML XML 字符串。返回原始音频 Buffer——响应体就是音频文件本身
// （X-Microsoft-OutputFormat 定死 riff-24khz-16bit-mono-pcm，带 RIFF 头的 wav，
// 采样率对齐 domain/wav.js 的假设），不像有些 API 还要多包一层 JSON，
// 跟 groq/deepgram 两个 adapter 的返回形状一致。
export async function synthesizeSsml(ssml) {
  if (!config.azureSpeechKey) {
    throw new Error('AZURE_SPEECH_KEY 未设置，请检查 .env 文件');
  }

  const response = await fetchWithTimeout(`${baseUrl()}/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': config.azureSpeechKey,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm',
      // Azure 要求必须带 User-Agent，否则请求会被拒绝。
      'User-Agent': 'cicada-discord-bot',
    },
    body: ssml,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Azure Speech TTS 请求失败：${response.status} ${response.statusText} ${errText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}
