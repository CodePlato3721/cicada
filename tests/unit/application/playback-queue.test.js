import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearPlaybackQueue,
  getPlaybackQueueDebugState,
  skipPlaybackSequence,
} from '../../../dist/adapter/out/playback-queue.js';

const FAKE_CONNECTION = {};

test('skipPlaybackSequence creates the queue so early skipped sequences are not lost', () => {
  const guildId = `guild-${Math.random().toString(36).slice(2)}`;

  skipPlaybackSequence(guildId, FAKE_CONNECTION, 0);
  skipPlaybackSequence(guildId, FAKE_CONNECTION, 1);

  assert.deepEqual(getPlaybackQueueDebugState(guildId), {
    nextSequence: 2,
    pendingSequences: [],
    running: false,
  });

  clearPlaybackQueue(guildId);
});
