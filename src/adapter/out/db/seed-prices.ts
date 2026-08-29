import type { PoolClient } from 'pg';
import { dbPool } from './client.js';

type ProviderPriceSeed = {
  provider: string;
  model: string;
  stage: 'stt' | 'llm' | 'tts';
  priceKind: 'base' | 'addon_keyterm_prompting';
  unit:
    | 'audio_minute'
    | 'audio_second'
    | 'input_1m_tokens'
    | 'cached_input_1m_tokens'
    | 'output_1m_tokens'
    | 'reasoning_1m_tokens'
    | 'input_1m_chars'
    | 'input_1k_chars';
  priceUsd: number;
};

export const PROVIDER_PRICE_SEEDS: ProviderPriceSeed[] = [
  { provider: 'deepgram', model: 'nova-3', stage: 'stt', priceKind: 'base', unit: 'audio_minute', priceUsd: 0.0058 },
  {
    provider: 'deepgram',
    model: 'nova-3',
    stage: 'stt',
    priceKind: 'addon_keyterm_prompting',
    unit: 'audio_minute',
    priceUsd: 0.0013,
  },
  { provider: 'deepgram', model: 'aura-2', stage: 'tts', priceKind: 'base', unit: 'input_1k_chars', priceUsd: 0.03 },
  { provider: 'azure', model: 'neural', stage: 'tts', priceKind: 'base', unit: 'input_1m_chars', priceUsd: 15 },
  { provider: 'azure', model: 'conversation', stage: 'stt', priceKind: 'base', unit: 'audio_second', priceUsd: 0.00027778 },
  { provider: 'deepseek', model: 'deepseek-v4-flash', stage: 'llm', priceKind: 'base', unit: 'cached_input_1m_tokens', priceUsd: 0.014 },
  { provider: 'deepseek', model: 'deepseek-v4-flash', stage: 'llm', priceKind: 'base', unit: 'input_1m_tokens', priceUsd: 0.44 },
  { provider: 'deepseek', model: 'deepseek-v4-flash', stage: 'llm', priceKind: 'base', unit: 'output_1m_tokens', priceUsd: 1.32 },
  { provider: 'openai', model: 'gpt-5-nano', stage: 'llm', priceKind: 'base', unit: 'input_1m_tokens', priceUsd: 0.05 },
  { provider: 'openai', model: 'gpt-5-nano', stage: 'llm', priceKind: 'base', unit: 'cached_input_1m_tokens', priceUsd: 0.005 },
  { provider: 'openai', model: 'gpt-5-nano', stage: 'llm', priceKind: 'base', unit: 'output_1m_tokens', priceUsd: 0.4 },
];

async function seedOneProviderPrice(client: PoolClient, seed: ProviderPriceSeed): Promise<void> {
  await client.query(
    `
      update provider_prices
      set effective_to = now()
      where provider = $1
        and model = $2
        and stage = $3
        and price_kind = $4
        and unit = $5
        and effective_to is null
        and price_usd <> $6
    `,
    [seed.provider, seed.model, seed.stage, seed.priceKind, seed.unit, seed.priceUsd],
  );

  await client.query(
    `
      insert into provider_prices (provider, model, stage, price_kind, unit, price_usd)
      select $1, $2, $3, $4, $5, $6
      where not exists (
        select 1
        from provider_prices
        where provider = $1
          and model = $2
          and stage = $3
          and price_kind = $4
          and unit = $5
          and price_usd = $6
          and effective_to is null
      )
    `,
    [seed.provider, seed.model, seed.stage, seed.priceKind, seed.unit, seed.priceUsd],
  );
}

export async function seedProviderPrices(): Promise<number> {
  const client = await dbPool.connect();
  try {
    await client.query('begin');
    for (const seed of PROVIDER_PRICE_SEEDS) {
      await seedOneProviderPrice(client, seed);
    }
    await client.query('commit');
    return PROVIDER_PRICE_SEEDS.length;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

