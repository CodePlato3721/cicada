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

-- 显式指定 schema，不依赖 search_path 自动解析——生产库上遇到过 CREATE EXTENSION（不同于
-- 普通 CREATE TABLE）在默认 search_path("$user", public，"$user" 对应的 cicada 这个 schema
-- 不存在)下解析不到目标 schema、报 "no schema been selected to create in" 的问题，本地
-- Docker 测试没复现是因为本地 cicada 角色是超级用户，不受这条限制。加上 `schema public`
-- 绕开这个含糊的隐式解析，不管具体是权限问题还是解析逻辑本身的坑，显式指定都更稳妥。
create extension if not exists pgcrypto schema public;

-- plan_id 的合法取值和默认值跟 src/config/pricing-plans.json 手动保持一致（Flyway 迁移
-- 文件是纯 SQL，跑的时候不会去读那份 JSON——这里的字面量是 pricing-plans.json 当前内容
-- 的快照：四档 starter/pro/unlimited/beta，默认套餐是标了 isDefault: true 的 beta，见
-- plans.ts 里 DEFAULT_PLAN_ID 的推导逻辑。以后 pricing-plans.json 增删套餐/换默认档，
-- 这条 check 约束不会自动跟着变，需要新增一条 Vn__ 迁移手动改（跟 plans.ts/billing-cli.ts
-- 那种"改一份 JSON 全自动同步"的动态派生不是一回事，SQL 层这道约束目前还没做到那个程度）。
create table billing_accounts (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null unique,
  plan_id text not null default 'beta' check (plan_id in ('starter', 'pro', 'unlimited', 'beta')),
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
