-- 每日用量/花费汇总，给 cron job（src/rollup-daily-usage.ts）用——从 usage_events
-- （V4，逐次调用的原始事件，7 天后自动压缩）按天聚合成一张小表，两个目的：
-- 1) 报表/看板查询不用每次扫全量原始事件（尤其是压缩后的旧 chunk，查询会变慢）；
-- 2) usage_events 本身没有算好的花费，只有 provider/model/token/时长这些原始量，
--    花费要拿 provider_prices 现算——算一次存下来，不用每次报表查询都重算一遍。
--
-- 粒度是 (usage_date, guild_id, stage, provider, model) 而不是每个 guild 每天一行——
-- 保留这四个维度才能在查询时任意上卷（按 guild 汇总/按 provider 汇总/全局每日总花费
-- 都是简单 group by，不用拆 jsonb），代价是行数比"一行一个 guild 一天"多一点，
-- 但这张表本来写入量就很小（一天顶多是 guild 数 × stage/provider/model 组合数这个
-- 量级，不是 usage_events 那种逐次调用的量级），不需要为了少几行牺牲查询灵活性。
--
-- 不做成 hypertable：hypertable 是为"高频、按时间写入"的负载设计的（usage_events/
-- transcript_events 那种逐次调用/逐句话），这张表一天只写一次（cron 跑一次），
-- 用普通表 + 按 usage_date 的索引就够了，套 hypertable 反而是不必要的开销。
--
-- 之所以不直接往 daily_guild_usage（V1 已有）加列复用：那张表是"实时"的，跟着
-- Redis session 状态在会话进行中随时增量 update（见 billing-service.ts 的
-- syncDailyUsageToDb），只覆盖 stt_seconds/text_chars 两个跟套餐配额相关的维度；
-- 这张新表是"事后"的，每天跑一次从 usage_events 批量算出来、可以任意重跑/回填
-- （on conflict 幂等），覆盖的维度也更全（含 TTS、token 细分、花费）。两者更新
-- 时机和数据来源都不是一回事，硬塞进同一张表会把"实时配额计数器"和"离线审计报表"
-- 两个不同职责混在一起。
create table daily_usage_cost (
  usage_date date not null,
  guild_id text not null,
  stage text not null check (stage in ('stt', 'llm', 'tts')),
  provider text not null,
  model text not null,
  call_count integer not null default 0,
  audio_duration_sec numeric(14, 3) not null default 0,
  input_text_chars bigint not null default 0,
  output_text_chars bigint not null default 0,
  prompt_tokens bigint not null default 0,
  cached_prompt_tokens bigint not null default 0,
  completion_tokens bigint not null default 0,
  reasoning_tokens bigint not null default 0,
  estimated_cost_usd numeric(14, 6) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (usage_date, guild_id, stage, provider, model)
);

-- 报表最常见的查询是"某一天/某个区间的总花费"，不带 guild_id 条件（全局视角），
-- 所以单独给 usage_date 建索引，不只是依赖主键里 usage_date 排第一列这件事
-- （primary key 本身已经能支持这个查询，这里是显式化，跟 usage_events 的
-- guild_time_idx/stage_provider_idx 两个查询维度分别建索引是同一个思路）。
create index daily_usage_cost_date_idx on daily_usage_cost (usage_date desc);

comment on table daily_usage_cost is '每日用量/花费汇总，从 usage_events 按天聚合，src/rollup-daily-usage.ts（cron）每天写一次，on conflict 幂等可重跑/回填';
