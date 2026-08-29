import { mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../../config.js';
import { todayUtc } from '../../domain/date.js';
import { createLogger } from './logger.js';

const logger = createLogger('events-log');

function eventsFilePath(guildId: string): string {
  return join(config.eventsDir, `events_${guildId}.${todayUtc()}.jsonl`);
}

let dirEnsured = false;
async function ensureEventsDir(): Promise<void> {
  if (dirEnsured) return;
  await mkdir(config.eventsDir, { recursive: true });
  dirEnsured = true;
}

export async function appendUsageEvent(guildId: string, event: Record<string, unknown>): Promise<void> {
  await ensureEventsDir();
  const line = `${JSON.stringify({ ...event, loggedAt: new Date().toISOString() })}\n`;
  await appendFile(eventsFilePath(guildId), line, 'utf8');
}

export function logEventsWriteFailure(guildId: string, err: unknown): void {
  logger.error({ err, guildId }, `Failed to append usage event to JSONL log for guild ${guildId}`);
}
