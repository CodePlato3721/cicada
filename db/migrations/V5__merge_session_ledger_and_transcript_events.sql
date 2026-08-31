-- billing_session_ledger 和"对话素材 session"本质是同一个实体：一次 /join~/leave
-- 的翻译会话。最初设计成两张表——billing_session_ledger 在 /leave 时一次性 insert
-- 一整行；transcript_sessions 在 /join 时先 insert 拿 id，/leave 时再 update
-- ended_at——发现是重复建模同一个东西，合并成一张表 trans_sessions：/join 时插入
-- 一行（此刻只知道 guild_id/session_started_at），会话进行中可以 update 补充字段
-- （比如 /game、/config 切换游戏时更新 game_id），/leave 时 update 补齐
-- session_ended_at/duration_seconds/estimated_cost_usd/usage_breakdown。
--
-- 这行现在无条件插入（billing 计费不看 guilds.transcript_retention_enabled 开关），
-- 跟"要不要真的采集对话文本"是两件事——后者只影响 transcript_events 写不写，判断
-- 依据是这个开关的值本身（应用层缓存进 Redis session），不是 trans_sessions 这行
-- 存不存在。
alter table billing_session_ledger rename to trans_sessions;
alter table trans_sessions rename constraint billing_session_ledger_pkey to trans_sessions_pkey;
alter table trans_sessions rename constraint billing_session_ledger_check to trans_sessions_check;
alter index billing_session_ledger_guild_idx rename to trans_sessions_guild_idx;

-- 原来 insert 时 started/ended/duration 一次性填完，所以是 not null；现在 /join
-- 那一刻这两列还不知道，放宽成 nullable，/leave 时的 update 再补上。原有的
-- check (session_ended_at >= session_started_at) 不用动——session_ended_at 是
-- null 时这个表达式算出 null，Postgres 里 check 约束遇到 null 视为通过，不算违反。
alter table trans_sessions alter column session_ended_at drop not null;
alter table trans_sessions alter column duration_seconds drop not null;

-- 对话素材要用到的"当前游戏/场景"，/game、/config 切换游戏时增量 update；只存最新
-- 值，不保留历史（跟 Redis 里 session.game 是同一个模型）。
alter table trans_sessions add column game_id text;

comment on table trans_sessions is '一次 /join~/leave 的翻译会话：/join 时插入一行，会话中/结束时增量 update，不是一次性写完（billing 结算和 transcript_events 分组共用同一行）';

-- transcript_events：原文 + 译文，给以后分析特定场景（game_id）下的高频词/短语用。
-- 只有 guilds.transcript_retention_enabled = true 的 guild 才会写这张表——默认关闭，
-- 语音转写内容属于用户说话内容的持久化留存，不能默认全量采集。这个判断在应用层做
-- （session 里缓存的一个布尔标志，见 CLAUDE.md），不看 trans_sessions 这张表。
--
-- source_lang/target_lang 单独存在每一行里，不是从 trans_sessions 或 guilds 当前
-- 配置反查——同一个 session 中途可能通过 /config、/lang 切换语言，按写入时刻的
-- 实际配置记录才准确。
create table transcript_events (
  time timestamptz not null default now(),
  session_id uuid not null references trans_sessions (id),
  guild_id text not null,
  user_id text,
  sequence integer,
  game_id text,
  source_lang text not null,
  target_lang text not null,
  transcript_text text not null,
  translated_text text not null,
  term_hit_count integer not null default 0,
  cache_hit boolean not null default false
);

select create_hypertable('transcript_events', 'time');

create index transcript_events_session_idx on transcript_events (session_id, time);
create index transcript_events_guild_game_idx on transcript_events (guild_id, game_id, source_lang, time desc);

-- 无过期时间（长期语料库，不做 drop_chunks），但同样加压缩策略省磁盘——压缩后的
-- chunk 对查询透明，不丢数据。30 天比 usage_events 的 7 天更长，词频分析这类查询
-- 通常要回溯较长时间窗口，给近期数据留更长的未压缩窗口方便调试/抽查。
alter table transcript_events set (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'guild_id, game_id, source_lang, target_lang'
);

select add_compression_policy('transcript_events', compress_after => interval '30 days');
