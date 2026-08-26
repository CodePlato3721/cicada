import type { VoiceConnection } from '@discordjs/voice';
import { playPcmInChannel } from './playback.js';
import { createLogger } from './logger.js';

const logger = createLogger('playback-queue');

// 每个 guild 一条播放队列：STT/翻译/TTS 可以为不同句子并发跑（pipeline.js 顶部注释
// "发射后不管"），处理快的句子可能比处理慢的句子先跑到这里——如果单纯按"谁先到就先播"
// （FIFO），会出现后说的话先被播出来这种乱序（实测复现过：先说的句子因为翻译 API
// 响应慢了几秒，比后说的句子晚返回，结果后说的先播、先说的后播）。
//
// 用一个按 sequence（voice-listener.js 在 VAD 判定"这句话说完了"的那一刻同步分配的
// 严格递增编号，代表真实的说话先后顺序，不是"处理完的先后顺序"）严格排列的列表做
// 重排缓冲区，每个条目三种状态之一：
// - making：这句话还在 STT/翻译/TTS 处理中，还不知道最终有没有声音要播——sequence
//   号一分配出来就立刻在这里占位（markMaking），不是等处理完才第一次出现在队列里。
// - ready：处理完，真的有 PCM 音频要播（enqueuePlayback）。
// - skip：处理完但这句话没有产出音频（提前 return 的分支），或者处理失败，跳过不播
//   （skipPlaybackSequence）。
// drain() 只从队首往后走：遇到的是 ready 就播放并移出列表，是 skip 就直接移出不播放，
// 一旦遇到还是 making 的条目就停下等着——就算它后面已经有别的 ready/skip 条目排好队，
// 也必须先等队首这个号位有结果。跟以前"Map<sequence, Buffer|null> + nextSequence 游标"
// 的写法是同一个不变量（必须先播完 sequence 小的，sequence 大的就算先到也要等着），
// 只是用显式的状态字段代替"缺席=making/null=skip/Buffer=ready"这种隐式编码。
interface QueueItem {
  sequence: number;
  status: 'making' | 'ready' | 'skip';
  pcm?: Buffer;
}

interface QueueState {
  items: QueueItem[]; // 按 sequence 严格递增排列，队首永远是最早说的那句
  connection: VoiceConnection;
  running: boolean;
  // 这一波积压期间是否已经提醒过"说慢点"——见 checkBacklogWarning。
  backlogWarned: boolean;
}

const queues = new Map<string, QueueState>(); // guildId -> QueueState

// 排队等播的条目（不管是 making 还是 ready，只要还没被 drain() 播出去/丢弃）超过这个数，
// 就认为翻译流水线跟不上说话速度了。3 是拍脑袋的初始值，不是压测出来的，如果实测偏松/
// 偏紧，调这一个常量就行，不用改调用方。
const BACKLOG_WARNING_THRESHOLD = 3;

function getOrCreateQueueState(guildId: string, connection: VoiceConnection): QueueState {
  let state = queues.get(guildId);
  if (!state) {
    state = { items: [], connection, running: false, backlogWarned: false };
    queues.set(guildId, state);
  }
  state.connection = connection; // 万一中途重连，保持引用最新
  return state;
}

function findItem(state: QueueState, sequence: number): QueueItem | undefined {
  return state.items.find((item) => item.sequence === sequence);
}

// voice-listener.js 在 nextPlaybackSequence(guildId) 刚拿到号码的那一刻调用——这时候
// STT/翻译/TTS 都还没跑，只是先占住这个 sequence 在队列里的位置，让 drain() 知道
// "这个号位还在处理中，不是空号，不能跳过"。sequence 是严格递增分配的，直接 push
// 到队尾就能保持整个列表按 sequence 有序，不需要按位置插入。
export function markMaking(guildId: string, connection: VoiceConnection, sequence: number): void {
  const state = getOrCreateQueueState(guildId, connection);
  state.items.push({ sequence, status: 'making' });
  logger.info(
    { guildId, sequence, pendingSequences: state.items.map((item) => `${item.sequence}:${item.status}`) },
    'Playback sequence marked as making',
  );
}

// 边沿检测："这一波积压是不是刚超过阈值"——不是"现在是不是超过阈值"。voice-listener.js
// 在每次 markMaking 之后调用一次：如果队列条目数超过 BACKLOG_WARNING_THRESHOLD 且这一波
// 积压还没提醒过，返回 true（调用方据此发一条频道文字提示）并标记 backlogWarned，之后
// 队列继续涨也不会再返回 true——不然积压持续几十句话就是几十条重复消息刷屏频道（同一类
// "重复通知"的坑 billing 每日限额提醒也踩过，见 session.js 的 shouldSendBillingNotification，
// 那边按"今天发过一次就不再发"去重，这里按"这一波积压发过一次就不再发"去重，去重维度
// 不同但目的一样）。backlogWarned 在 drain() 把积压清回阈值以下时重置，下一波新的积压
// 会重新提醒一次。
export function checkBacklogWarning(guildId: string): boolean {
  const state = queues.get(guildId);
  if (!state) return false;
  if (state.items.length > BACKLOG_WARNING_THRESHOLD && !state.backlogWarned) {
    state.backlogWarned = true;
    return true;
  }
  return false;
}

export { BACKLOG_WARNING_THRESHOLD };

// pipeline.js 的 handleSegment 真的产出了要播放的音频时调用。理论上这个 sequence 早就
// 该在 markMaking 时占过位了——找不到条目是防御性兜底（比如漏调了 markMaking），
// 直接补一条 ready，至少不丢这段音频，但会打一条 warn 方便发现调用顺序不对的问题。
export function enqueuePlayback(guildId: string, connection: VoiceConnection, pcmBuffer: Buffer, sequence: number): void {
  const state = getOrCreateQueueState(guildId, connection);
  const item = findItem(state, sequence);
  if (item) {
    item.status = 'ready';
    item.pcm = pcmBuffer;
  } else {
    logger.warn({ guildId, sequence }, 'enqueuePlayback called without a prior markMaking placeholder, inserting directly');
    state.items.push({ sequence, status: 'ready', pcm: pcmBuffer });
  }
  logger.info(
    { guildId, sequence, pendingSequences: state.items.map((i) => `${i.sequence}:${i.status}`) },
    'Playback queued',
  );
  drain(guildId);
}

// pipeline.js 有些分支最终没有产出任何要播放的音频（比如翻译结果是空的、目标语言没有
// 对应 TTS 供应商），但这个 sequence 号码已经被分配（并且 markMaking 占过位）——必须
// 显式"放弃"这个号位，不然重排缓冲区会一直卡在等一个永远不会来的 sequence，后面所有
// 已经到达、排在它后面的音频全部播不出来。pipeline.js 用 try/finally 保证每个 sequence
// 最终一定会调用 enqueuePlayback 或者这个函数中的一个，不会两个都不调、也不会两个都调。
export function skipPlaybackSequence(guildId: string, connection: VoiceConnection, sequence: number): void {
  const state = getOrCreateQueueState(guildId, connection);
  const item = findItem(state, sequence);
  if (item) {
    item.status = 'skip';
  } else {
    logger.warn({ guildId, sequence }, 'skipPlaybackSequence called without a prior markMaking placeholder, inserting directly');
    state.items.push({ sequence, status: 'skip' });
  }
  logger.info(
    { guildId, sequence, pendingSequences: state.items.map((i) => `${i.sequence}:${i.status}`) },
    'Playback sequence skipped',
  );
  drain(guildId);
}

async function drain(guildId: string): Promise<void> {
  const state = queues.get(guildId);
  // running 是这个队列的重入锁——同一个 guild 同一时刻只允许一个 drain() 在跑。没有
  // 这个锁的话，两句话几乎同时处理完时会各自认为"队首轮到我了"，同时调用
  // playPcmInChannel，导致同一个 Discord 语音连接上两段音频重叠/交错播出（实测分析过
  // 这个具体的竞态：nextSequence 之类的游标/状态在真正播放前就已经更新，第二次调用
  // drain() 会误判"轮到我了"，即使第一次调用还卡在 await playPcmInChannel 没播完）。
  // 换成显式的 items 列表之后这个竞态原理不变，锁必须留着，不是数据结构本身能替代的。
  if (!state || state.running) return;

  state.running = true;
  while (state.items.length > 0 && state.items[0].status !== 'making') {
    const item = state.items.shift()!;
    if (item.status === 'ready' && item.pcm) {
      try {
        await playPcmInChannel(state.connection, item.pcm);
      } catch (err) {
        logger.error({ err, guildId }, 'Playback queue error');
      }
    }
    // status === 'skip'（或者理论上不该出现的 ready-without-pcm）：直接丢弃，不播放
  }
  if (state.items.length > 0) {
    logger.info(
      { guildId, pendingSequences: state.items.map((i) => `${i.sequence}:${i.status}`) },
      'Playback queue waiting for earlier sequence',
    );
  }
  // 积压清回阈值以下了，重置提醒标记——下一波积压（哪怕是同一个 guild 短时间内再次
  // 涨上去）会重新触发一次 checkBacklogWarning，不会因为"这个 guild 曾经提醒过一次"
  // 就永远不再提醒。
  if (state.items.length <= BACKLOG_WARNING_THRESHOLD) {
    state.backlogWarned = false;
  }
  state.running = false;
}

export function clearPlaybackQueue(guildId: string): void {
  queues.delete(guildId);
}

export function getPlaybackQueueDebugState(guildId: string):
  | { items: Array<{ sequence: number; status: QueueItem['status'] }>; running: boolean }
  | undefined {
  const state = queues.get(guildId);
  if (!state) return undefined;
  return {
    items: state.items.map((item) => ({ sequence: item.sequence, status: item.status })),
    running: state.running,
  };
}
