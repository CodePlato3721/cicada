// 用法：
//   npm run rollup-usage                # 汇总"昨天"（UTC）
//   npm run rollup-usage -- 2026-08-25   # 汇总/回填指定日期（UTC），幂等，可重跑
//
// 从 usage_events（每次 STT/翻译/TTS 调用一行，见 db/migrations/V4）按天聚合成
// daily_usage_cost（db/migrations/V6）：按 (guild_id, stage, provider, model) 分组
// 求和原始用量，再用跟 session 结算同一套定价逻辑（cost-calculator.ts）算花费，
// upsert 进汇总表。设计背景见 V6 迁移文件顶部注释和 CLAUDE.md。
//
// 花费口径特意不区分 STT keyterm 加价（provider_prices 里的 addon_keyterm_prompting）——
// trans_sessions.estimated_cost_usd（会话结算）目前也没算这个加价（Redis 累计用量时
// 没有保留 keytermCount 这个维度，见 session.ts 的 accumulateSessionUsage），这里
// 故意保持跟会话结算同一个口径，两边的花费数字才能互相对得上、能拿来做 sanity check
// （比如"某天 daily_usage_cost 总花费应该约等于当天 trans_sessions 结束的会话花费之
// 和"）。如果以后要把这个加价补上，应该两个地方一起改，不要只改一边导致两个花费口径
// 悄悄分叉。
//
// 部署：不常驻进程，用 pm2 的 cron-restart 功能按天跑一次就退出（见 README「生产部署」
// 一节），不是独立常驻服务，也不用系统 crontab——跟这台机器已经用 pm2 管理 cicada 主
// 进程是同一套工具，日志统一走 `pm2 logs`，不用额外记一套 crontab 操作方式。
import 'dotenv/config';
import type { PoolClient } from 'pg';
import { dbPool, ensureDatabaseReady } from './adapter/out/db/client.js';
import { calculateEstimatedCostUsd } from './application/billing/cost-calculator.js';
import { createLogger } from './adapter/out/logger.js';
import type { ExternalApiUsage } from './application/billing/types.js';

const logger = createLogger('rollup-daily-usage');

interface UsageGroupRow {
  guild_id: string;
  stage: 'stt' | 'llm' | 'tts';
  provider: string;
  model: string;
  call_count: string;
  audio_duration_sec: string;
  input_text_chars: string;
  output_text_chars: string;
  prompt_tokens: string;
  cached_prompt_tokens: string;
  completion_tokens: string;
  reasoning_tokens: string;
}

// UTC "昨天"——跟项目其他地方对齐（todayUtc()/usage_date 全部按 UTC 天切分,
// 不是服务器本地时区),不额外引入一种新的取整方式。
function yesterdayUtc(): string {
  const now = new Date();
  const y = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  return y.toISOString().slice(0, 10);
}

async function fetchUsageGroups(client: PoolClient, usageDate: string): Promise<UsageGroupRow[]> {
  const result = await client.query<UsageGroupRow>(
    `
      select
        guild_id,
        stage,
        coalesce(provider, 'unknown') as provider,
        coalesce(model, 'unknown') as model,
        count(*)::int as call_count,
        coalesce(sum(coalesce(provider_audio_duration_sec, audio_duration_sec)), 0) as audio_duration_sec,
        coalesce(sum(input_text_chars), 0) as input_text_chars,
        coalesce(sum(output_text_chars), 0) as output_text_chars,
        coalesce(sum(prompt_tokens), 0) as prompt_tokens,
        coalesce(sum(cached_prompt_tokens), 0) as cached_prompt_tokens,
        coalesce(sum(completion_tokens), 0) as completion_tokens,
        coalesce(sum(reasoning_tokens), 0) as reasoning_tokens
      from usage_events
      where "time" >= $1::date and "time" < $1::date + interval '1 day'
      group by guild_id, stage, provider, model
    `,
    [usageDate],
  );
  return result.rows;
}

async function upsertDailyUsageCost(client: PoolClient, usageDate: string, group: UsageGroupRow, estimatedCostUsd: number): Promise<void> {
  await client.query(
    `
      insert into daily_usage_cost (
        usage_date, guild_id, stage, provider, model, call_count, audio_duration_sec,
        input_text_chars, output_text_chars, prompt_tokens, cached_prompt_tokens,
        completion_tokens, reasoning_tokens, estimated_cost_usd
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      on conflict (usage_date, guild_id, stage, provider, model) do update
      set call_count = excluded.call_count,
          audio_duration_sec = excluded.audio_duration_sec,
          input_text_chars = excluded.input_text_chars,
          output_text_chars = excluded.output_text_chars,
          prompt_tokens = excluded.prompt_tokens,
          cached_prompt_tokens = excluded.cached_prompt_tokens,
          completion_tokens = excluded.completion_tokens,
          reasoning_tokens = excluded.reasoning_tokens,
          estimated_cost_usd = excluded.estimated_cost_usd,
          updated_at = now()
    `,
    [
      usageDate,
      group.guild_id,
      group.stage,
      group.provider,
      group.model,
      Number(group.call_count),
      Number(group.audio_duration_sec),
      Number(group.input_text_chars),
      Number(group.output_text_chars),
      Number(group.prompt_tokens),
      Number(group.cached_prompt_tokens),
      Number(group.completion_tokens),
      Number(group.reasoning_tokens),
      estimatedCostUsd,
    ],
  );
}

async function rollupDate(usageDate: string): Promise<void> {
  const client = await dbPool.connect();
  try {
    const groups = await fetchUsageGroups(client, usageDate);
    let totalCostUsd = 0;

    for (const group of groups) {
      const usage: ExternalApiUsage = {
        stage: group.stage,
        provider: group.provider,
        model: group.model,
        audioDurationSec: Number(group.audio_duration_sec),
        promptTokens: Number(group.prompt_tokens),
        cachedPromptTokens: Number(group.cached_prompt_tokens),
        completionTokens: Number(group.completion_tokens),
        reasoningTokens: Number(group.reasoning_tokens),
        inputTextChars: Number(group.input_text_chars),
      };
      const estimatedCostUsd = await calculateEstimatedCostUsd(client, usage);
      await upsertDailyUsageCost(client, usageDate, group, estimatedCostUsd);
      totalCostUsd += estimatedCostUsd;
    }

    logger.info(
      { usageDate, guildGroups: groups.length, totalCostUsd: Number(totalCostUsd.toFixed(6)) },
      `rolled up ${groups.length} usage group(s) for ${usageDate}, total estimated cost $${totalCostUsd.toFixed(6)}`,
    );
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  await ensureDatabaseReady();
  const usageDate = process.argv[2] ?? yesterdayUtc();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(usageDate)) {
    throw new Error(`Invalid date "${usageDate}", expected YYYY-MM-DD`);
  }
  await rollupDate(usageDate);
}

main()
  .catch((err) => {
    logger.error({ err }, 'daily usage rollup failed');
    process.exitCode = 1;
  })
  .finally(() => dbPool.end());
