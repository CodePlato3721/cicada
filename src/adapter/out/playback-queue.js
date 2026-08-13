import { playPcmInChannel } from './playback.js';

// 每个 guild 一条播放队列：STT/翻译/TTS 可以为不同句子并发跑，
// 但最终播到语音频道里必须排队——不然两句话的音频会叠在一起变成噪音。
const queues = new Map(); // guildId -> { queue: PcmBuffer[], connection, running: boolean }

export function enqueuePlayback(guildId, connection, pcmBuffer) {
  let state = queues.get(guildId);
  if (!state) {
    state = { queue: [], connection, running: false };
    queues.set(guildId, state);
  }
  state.connection = connection; // 万一中途重连，保持引用最新
  state.queue.push(pcmBuffer);
  drain(guildId);
}

async function drain(guildId) {
  const state = queues.get(guildId);
  if (!state || state.running) return;

  state.running = true;
  while (state.queue.length > 0) {
    const pcm = state.queue.shift();
    try {
      await playPcmInChannel(state.connection, pcm);
    } catch (err) {
      console.error('播放队列出错：', err);
    }
  }
  state.running = false;
}

export function clearPlaybackQueue(guildId) {
  queues.delete(guildId);
}
