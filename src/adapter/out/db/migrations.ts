import { dbPool } from './client.js';

export const BILLING_SCHEMA_SQL = `
create extension if not exists pgcrypto;

-- 2026-08-23：daily_usage_counters.voice_seconds 以前存的是"STT 识别时长总和"，口径
-- 是错的（实测发现混进了 TTS 播报时长，且完全没有覆盖"人没说话但 bot 还占着频道"的
-- 时间）。改成按连接时长打点（见已删除的 connection-usage-tracker.ts），表和字段
-- 一起改名成 daily_guild_usage.connected_seconds。
-- 这两条 rename 只在老部署（表已存在、还叫旧名字）时才会真正执行，新部署表还不
-- 存在，直接空操作，走下面 create table if not exists 的新名字。
alter table if exists daily_usage_counters rename to daily_guild_usage;
alter table if exists daily_guild_usage rename column voice_seconds to connected_seconds;

-- 2026-08-23（同一天，第二次改）：connected_seconds 这个墙钟时长口径又被撤销了——
-- connection-usage-tracker.ts 整个删掉，不再需要一个独立定时器每 5 分钟戳一次
-- Postgres。限额判断改回"今天 STT 实际识别过的语音时长"（跟这条 rename 之前、
-- 8/14 之前的旧语义一致），字段改名 connected_seconds -> stt_seconds。同样只在
-- 老部署上才会真正执行。
alter table if exists daily_guild_usage rename column connected_seconds to stt_seconds;

-- billing_accounts.balance_usd 曾经是"可花的钱包余额"语义（pay-as-you-go），但这个
-- 产品从来没真正做成按量计费——balance_usd 从没被 checkBillingAllowed 读来判断"要不要
-- 拦"，纯粹是每次调用完 provider 之后往下扣的一个数字，没人用它做过决策。改名成
-- lifetime_cost_usd，语义变成"这个 guild 累计估算成本"，只增不减，纯展示/分析用途，
-- 不再是一个会被拦截逻辑读取的余额。
alter table if exists billing_accounts rename column balance_usd to lifetime_cost_usd;

-- 2026-08-23 新增：剩余时长/剩余字符曾经是"读的时候用 plan 上限 - daily_guild_usage
-- 今天已用量现算"（billing-cli.js 的 guild 命令，SQL join + JS 减法）。改成物化列，
-- 只在本来就有的低频同步点（60 秒定时/跨限额线/session 结束/跨天重置/手动改
-- 套餐）写一次,读的时候直接查列,不再每次读都重新算。NULL 代表这个套餐这一项
-- 不限量（server 套餐）。老部署用 add column if not exists 补上,不影响已有数据。
alter table if exists billing_accounts add column if not exists stt_seconds_remaining numeric(12, 3);
alter table if exists billing_accounts add column if not exists text_chars_remaining integer;

create table if not exists billing_accounts (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null unique,
  plan_id text not null default 'free' check (plan_id in ('free', 'server')),
  status text not null default 'active' check (status in ('active', 'suspended')),
  lifetime_cost_usd numeric(12, 6) not null default 0,
  stt_seconds_remaining numeric(12, 3),
  text_chars_remaining integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists provider_prices (
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

create index if not exists provider_prices_lookup_idx
  on provider_prices (provider, model, stage, price_kind, effective_from desc)
  where effective_to is null;

-- 2026-08-23：usage_events/billing_ledger 整个删掉，不再保留为历史只读表。理由：
-- (1) 每次调用的基本信息现在改写进本地按天按 guild 滚动的 JSONL 文件
--     （adapter/out/events-log.js），usage_events 的职责已经完全被取代；
-- (2) billing_ledger 原本是 pay-as-you-go 钱包余额模型的流水表（充值/扣费/退款），
--     这个产品从来没做成按量计费，用户只能升级/降级套餐，没有"充值"这回事，这张表
--     的存在前提本身就不成立；
-- (3) 用户明确要求删除这两张表，不是"不再写入但保留读取"。
-- drop billing_ledger 在前，因为它有外键指向 usage_events(id)。
drop table if exists billing_ledger cascade;
drop table if exists usage_events cascade;

-- 以后如果要记录套餐升级/降级这类账号变更历史，会是一张新表（比如
-- billing_account_plan_changes），现在先不加——见 CLAUDE.md，这是留白，不是遗漏。

create table if not exists daily_guild_usage (
  guild_id text not null,
  usage_date date not null,
  stt_seconds numeric(12, 3) not null default 0,
  text_chars integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (guild_id, usage_date)
);

-- 2026-08-23 新增：一场会话（/join 到 /leave）一行，取代"每次 provider 调用一行"的
-- usage_events。estimated_cost_usd 是 /leave 时用 Redis 里这场会话按 (stage, provider,
-- model) 分组累加的原始用量（STT 秒数/LLM token 数/TTS 字符数），对照 provider_prices
-- 现价算出来的——不是用 session_started_at/session_ended_at 的时间差算的，时长和成本
-- 是两回事（时长可能很长但大部分时间没人说话，成本该接近 0）。usage_breakdown 存一份
-- 按 stage/provider/model 拆分的明细 JSON，方便事后核对某场会话的成本是怎么来的。
create table if not exists billing_session_ledger (
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

create index if not exists billing_session_ledger_guild_idx
  on billing_session_ledger (guild_id, session_started_at desc);
`;

export async function migrateBillingSchema(): Promise<void> {
  await dbPool.query(BILLING_SCHEMA_SQL);
}
