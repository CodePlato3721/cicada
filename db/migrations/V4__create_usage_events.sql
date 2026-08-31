-- usage_events 这个表名之前存在过、又被删掉过（见 commit e4e2059「Redesign billing
-- to Redis-first counters, drop per-call DB writes」，2026-08-23）——当时是每次
-- STT/翻译/TTS 调用都直接写一行到普通 Postgres 表，写入频率扛不住，改成 Redis
-- 原子计数器 + 本地 JSONL 审计日志（adapter/out/events-log.ts，EVENTS_DIR）。
--
-- 这次用 TimescaleDB hypertable 重新做这件事：按时间自动分区（chunk）+ 压缩策略，
-- 是专门为"高频、按时间写入、历史数据基本不整行更新"这种负载设计的，跟当年直接写
-- vanilla 表撑不住不是一回事。上线后 events-log.ts/EVENTS_DIR 整个删除，Postgres
-- 是唯一来源，不再有 JSONL 兜底。
--
-- 常用查询维度（guild/stage/provider/model/时间）做成实列方便建索引/聚合；供应商
-- 各自 SDK 返回的原始 usage 字段五花八门、以后还可能变，不逐个建列，整个事件对象
-- 存进 raw jsonb 兜底，对应 ExternalApiUsage 类型里 `usage?: unknown` 那个兜底字段。
create table usage_events (
  time timestamptz not null default now(),
  guild_id text not null,
  user_id text,
  sequence integer,
  stage text not null check (stage in ('stt', 'llm', 'tts')),
  provider text,
  model text,
  source_lang text,
  target_lang text,
  voice text,
  elapsed_ms integer,
  input_text_chars integer,
  output_text_chars integer,
  prompt_tokens integer,
  completion_tokens integer,
  total_tokens integer,
  cached_prompt_tokens integer,
  reasoning_tokens integer,
  audio_duration_sec numeric(12, 3),
  provider_audio_duration_sec numeric(12, 3),
  audio_bytes integer,
  chunk_count integer,
  keyterm_count integer,
  raw jsonb
);

select create_hypertable('usage_events', 'time');

create index usage_events_guild_time_idx on usage_events (guild_id, time desc);
create index usage_events_stage_provider_idx on usage_events (stage, provider, model, time desc);

-- 不设保留期（跟之前的 JSONL 一样不自动删除），但加压缩策略省磁盘——生产这台机器
-- 磁盘不宽裕，压缩对查询透明、不丢数据，纯粹省空间。7 天之前的 chunk 自动压缩，
-- 近 7 天原始数据留着方便排查最近的问题。
alter table usage_events set (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'guild_id, stage, provider, model'
);

select add_compression_policy('usage_events', compress_after => interval '7 days');
