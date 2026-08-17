// 给所有自己手写 fetch 调用的 adapter（DeepSeek/Deepgram，没有官方 SDK 兜底超时）统一加超时保护。
// Groq 走官方 SDK，超时通过 SDK 自己的 timeout/maxRetries 配置（见 groq/client.js），不走这里。
//
//
// 背景：实测踩过坑——DeepSeek 有一次单次请求卡了 34 秒才返回，期间这句话的整条流水线
// 悄悄挂在后台，用户完全感知不到，等它终于返回时会跟后面已经处理完的句子一起爆发式播出来，
// 体验上像是"卡了很久突然冒出好几句话"。没有超时的话，慢请求会无限拖着不失败、不重试。
const TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS ?? 5000);

export async function fetchWithTimeout(url: string, options?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request timed out (no response after ${TIMEOUT_MS}ms): ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
