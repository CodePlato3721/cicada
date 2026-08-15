import { playPcmInChannel } from './playback.js';

// 每个 guild 一条播放队列：STT/翻译/TTS 可以为不同句子并发跑（pipeline.js 顶部注释
// "发射后不管"），处理快的句子可能比处理慢的句子先跑到这里——如果单纯按"谁先到就先播"
// （FIFO），会出现后说的话先被播出来这种乱序（实测复现过：先说的句子因为翻译 API
// 响应慢了几秒，比后说的句子晚返回，结果后说的先播、先说的后播）。
//
// 这里不是纯 FIFO，是按 sequence（这句话被 VAD 判定说完的那一刻，在 voice-listener.js
// 里同步分配的严格递增编号，代表真实的说话先后顺序，不是"处理完的先后顺序"）做一个
// 重排缓冲区：必须先播完 sequence 小的，sequence 大的就算先到也要等着。
const queues = new Map(); // guildId -> { pending: Map<sequence, pcmBuffer|null>, nextSequence, connection, running }

function getOrCreateQueueState(guildId, connection) {
  let state = queues.get(guildId);
  if (!state) {
    // nextSequence 从 0 开始——跟 session.js 的 playbackSeq 每次 /join 都从 0 计数
    // 是同一套约定，两边"从 0 开始"靠约定对齐，这里没法验证对不对，只能保证自己遵守。
    state = { pending: new Map(), nextSequence: 0, connection, running: false };
    queues.set(guildId, state);
  }
  state.connection = connection; // 万一中途重连，保持引用最新
  return state;
}

export function enqueuePlayback(guildId, connection, pcmBuffer, sequence) {
  const state = getOrCreateQueueState(guildId, connection);
  state.pending.set(sequence, pcmBuffer);
  drain(guildId);
}

// pipeline.js 有些分支最终没有产出任何要播放的音频（比如翻译结果是空的、目标语言没有
// 对应 TTS 供应商），但这个 sequence 号码已经被分配出去了——必须显式"放弃"这个号位，
// 不然重排缓冲区会一直卡在等一个永远不会来的 sequence，后面所有已经到达、排在它后面
// 的音频全部播不出来。pipeline.js 用 try/finally 保证每个 sequence 最终一定会调用
// enqueuePlayback 或者这个函数中的一个，不会两个都不调、也不会两个都调。
export function skipPlaybackSequence(guildId, sequence) {
  const state = queues.get(guildId);
  if (!state) return; // 这个 guild 还没播过任何东西，队列都没建立过，没什么好跳过的
  state.pending.set(sequence, null); // null 代表"这个号位故意空着，不播"
  drain(guildId);
}

async function drain(guildId) {
  const state = queues.get(guildId);
  if (!state || state.running) return;

  state.running = true;
  while (state.pending.has(state.nextSequence)) {
    const pcm = state.pending.get(state.nextSequence);
    state.pending.delete(state.nextSequence);
    state.nextSequence += 1;

    if (pcm === null) continue; // 被跳过的号位，直接跳过，不播放

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
