import { mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../../config.js';
import { todayUtc } from '../../domain/date.js';
import { createLogger } from './logger.js';

const logger = createLogger('events-log');

// usage_events 表曾经是"每句话 STT/翻译/TTS 都各自开一个事务写一行"的高频 Postgres
// 写入（见 CLAUDE.md billing 重设计一节）——不可接受。这里换成本地按天按 guild 滚动的
// JSONL 文件：纯审计/排查用途（人工事后用文本处理脚本统计），不参与账单判断/成本计算，
// 那部分现在走 session.ts 的 Redis 累加器（见 billing-service.js 的
// accumulateSessionUsage/finalizeSessionLedger）。按 guild 拆文件是刻意的——多个 guild
// 的 pipeline 并发写、各自 append 到自己的文件，不会撞出并发写入同一个文件的问题；
// 按天滚动避免单文件无限增长，旧文件靠文本处理脚本或外部日志轮转自己清，这里不做
// 自动删除。
function eventsFilePath(guildId: string): string {
  return join(config.eventsDir, `events_${guildId}.${todayUtc()}.jsonl`);
}

let dirEnsured = false;
async function ensureEventsDir(): Promise<void> {
  if (dirEnsured) return;
  await mkdir(config.eventsDir, { recursive: true });
  dirEnsured = true;
}

// event：基本调用信息（stage/provider/model/guildId/userId/sequence/语言/耗时/用量数字），
// 不含成本——成本只在 billing_session_ledger 里按整场会话算一次，这里的目的是留一份
// 能追溯"这句话到底经过了哪些供应商调用"的原始记录，不是账单来源。写入失败只记日志，
// 不能拖慢或中断翻译主链路（调用方 .catch 处理，见 billing-service.js）。
export async function appendUsageEvent(guildId: string, event: Record<string, unknown>): Promise<void> {
  await ensureEventsDir();
  const line = `${JSON.stringify({ ...event, loggedAt: new Date().toISOString() })}\n`;
  await appendFile(eventsFilePath(guildId), line, 'utf8');
}

export function logEventsWriteFailure(guildId: string, err: unknown): void {
  logger.error({ err, guildId }, `Failed to append usage event to JSONL log for guild ${guildId}`);
}
