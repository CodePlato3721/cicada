import type { VoiceConnection } from '@discordjs/voice';
import { playPcmInChannel } from './playback.js';
import { createLogger } from './logger.js';

const logger = createLogger('playback-queue');

interface QueueItem {
  sequence: number;
  status: 'making' | 'ready' | 'skip';
  pcm?: Buffer;
}

interface QueueState {
  items: QueueItem[];
  connection: VoiceConnection;
  running: boolean;
  backlogWarned: boolean;
}

const queues = new Map<string, QueueState>();

const BACKLOG_WARNING_THRESHOLD = 3;

function getOrCreateQueueState(guildId: string, connection: VoiceConnection): QueueState {
  let state = queues.get(guildId);
  if (!state) {
    state = { items: [], connection, running: false, backlogWarned: false };
    queues.set(guildId, state);
  }
  state.connection = connection;
  return state;
}

function findItem(state: QueueState, sequence: number): QueueItem | undefined {
  return state.items.find((item) => item.sequence === sequence);
}

export function markMaking(guildId: string, connection: VoiceConnection, sequence: number): void {
  const state = getOrCreateQueueState(guildId, connection);
  state.items.push({ sequence, status: 'making' });
  logger.info(
    { guildId, sequence, pendingSequences: state.items.map((item) => `${item.sequence}:${item.status}`) },
    'Playback sequence marked as making',
  );
}

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
  }
  if (state.items.length > 0) {
    logger.info(
      { guildId, pendingSequences: state.items.map((i) => `${i.sequence}:${i.status}`) },
      'Playback queue waiting for earlier sequence',
    );
  }
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
