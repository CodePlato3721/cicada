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
