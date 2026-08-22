import { dbPool } from './client.js';

export const BILLING_SCHEMA_SQL = `
create extension if not exists pgcrypto;

create table if not exists billing_accounts (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null unique,
  plan_id text not null default 'free' check (plan_id in ('free', 'server')),
  status text not null default 'active' check (status in ('active', 'suspended')),
  balance_usd numeric(12, 6) not null default 0,
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

create table if not exists usage_events (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  user_id text,
  sequence integer,
  stage text not null check (stage in ('stt', 'llm', 'tts')),
  provider text,
  model text,
  source_lang text,
  target_lang text,
  quantity_audio_seconds numeric(12, 3),
  quantity_text_chars integer,
  keyterm_count integer,
  prompt_tokens integer,
  cached_prompt_tokens integer,
  completion_tokens integer,
  reasoning_tokens integer,
  estimated_cost_usd numeric(12, 8) not null default 0,
  usage_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists usage_events_guild_created_idx
  on usage_events (guild_id, created_at desc);

create index if not exists usage_events_stage_created_idx
  on usage_events (stage, created_at desc);

create table if not exists billing_ledger (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references billing_accounts(id),
  type text not null check (type in ('credit', 'provider_cost', 'adjustment', 'refund')),
  amount_usd numeric(12, 6) not null,
  usage_event_id uuid references usage_events(id),
  description text,
  created_at timestamptz not null default now()
);

create index if not exists billing_ledger_account_created_idx
  on billing_ledger (account_id, created_at desc);

create table if not exists daily_usage_counters (
  guild_id text not null,
  usage_date date not null,
  voice_seconds numeric(12, 3) not null default 0,
  text_chars integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (guild_id, usage_date)
);
`;

export async function migrateBillingSchema(): Promise<void> {
  await dbPool.query(BILLING_SCHEMA_SQL);
}
