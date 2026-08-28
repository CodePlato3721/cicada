-- Flyway 基线迁移：接入 Flyway 之前，schema 由 src/adapter/out/db/migrations.ts 里一份手写
-- 累积幂等 SQL 脚本（create table if not exists / alter ... if not exists）管理，每次部署
-- 全量重放。改用 Flyway 后这份脚本已删除，这个文件是它最终状态的快照（去掉了针对老部署的
-- rename 兼容语句和已经执行过的 drop table，那些只是"从旧版本迁移过来"的过渡步骤，不是
-- 目标 schema 本身的一部分）。
--
-- 生产库已经有这些表（旧脚本建的），所以第一次接入 Flyway 时这个版本不能真的执行一遍，
-- 而是要用 `flyway baseline -baselineVersion=1` 把它标记成"已完成"，Flyway 之后只会执行
-- V2 及以后的迁移。全新环境（比如新建的 staging 库）没有这个历史包袱，直接 `flyway migrate`
-- 让 V1 正常跑一遍从零建表即可，不需要 baseline。
--
-- 这里不用 if not exists 保护——Flyway 靠自己的 flyway_schema_history 表保证每个版本
-- 只执行一次，不需要再靠 SQL 语句自己防重复执行，那是旧的手写累积脚本方案的做法。

create extension if not exists pgcrypto;

create table billing_accounts (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null unique,
  plan_id text not null default 'free' check (plan_id in ('free', 'server')),
  status text not null default 'active' check (status in ('active', 'suspended')),
  lifetime_cost_usd numeric(12, 6) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 物理列顺序特意跟生产库对齐：生产库是旧脚本用 alter table add column 后补上这两列
  -- 的，物理顺序排在最后；这里保持一致，让"给已有库跑 baseline"和"给全新库跑 V1"
  -- 建出来的表结构完全一样（不影响查询正确性——代码里都是按列名查，不依赖列顺序，
  -- 纯粹是为了两条路径产出一致的物理结构）。
  stt_seconds_remaining numeric(12, 3),
  text_chars_remaining integer
);

create table provider_prices (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  model text not null,
  stage text not null check (stage in ('stt', 'llm', 'tts')),
  price_kind text not null default 'base' check (price_kind in ('base', 'addon_keyterm_prompting')),
  unit text not null check (
    unit in (
      'audio_minute',
      'audio_second',
      'input_1m_tokens',
      'cached_input_1m_tokens',
      'output_1m_tokens',
      'reasoning_1m_tokens',
      'input_1m_chars',
      'input_1k_chars'
    )
  ),
  price_usd numeric(12, 8) not null check (price_usd >= 0),
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from)
);

create index provider_prices_lookup_idx
  on provider_prices (provider, model, stage, price_kind, effective_from desc)
  where effective_to is null;

create table daily_guild_usage (
  guild_id text not null,
  usage_date date not null,
  stt_seconds numeric(12, 3) not null default 0,
  text_chars integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (guild_id, usage_date)
);

create table billing_session_ledger (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  session_started_at timestamptz not null,
  session_ended_at timestamptz not null,
  duration_seconds numeric(12, 3) not null,
  estimated_cost_usd numeric(12, 8) not null default 0,
  usage_breakdown jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  check (session_ended_at >= session_started_at)
);

create index billing_session_ledger_guild_idx
  on billing_session_ledger (guild_id, session_started_at desc);
