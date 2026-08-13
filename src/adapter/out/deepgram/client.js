import { config } from '../../../config.js';
import { fetchWithTimeout } from '../http.js';

const BASE_URL = 'https://api.deepgram.com/v1';

function authHeader() {
  if (!config.deepgramApiKey) {
    throw new Error('DEEPGRAM_API_KEY 未设置，请检查 .env 文件');
  }
  return `Token ${config.deepgramApiKey}`;
}

async function handleResponse(response) {
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Deepgram API 请求失败：${response.status} ${response.statusText} ${errText}`);
  }
  return response;
}

// STT 用：直接传二进制音频文件（Content-Type 设成对应格式），不用像 Qwen 那样折腾
// base64/公网 URL。path/query 由调用方拼好整段（比如 '/listen?model=nova-3&...'）。
export async function postBinary(path, buffer, contentType) {
  const response = await fetchWithTimeout(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': contentType },
    body: buffer,
  });
  return handleResponse(response).then((r) => r.json());
}

// TTS 用：JSON body，响应直接是音频字节（不像 Qwen 还要多一次下载）。
export async function postJsonForAudio(path, body) {
  const response = await fetchWithTimeout(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ok = await handleResponse(response);
  return Buffer.from(await ok.arrayBuffer());
}
