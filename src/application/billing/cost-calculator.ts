import type { PoolClient } from 'pg';
import type { ExternalApiUsage } from './types.js';

type PriceRow = {
  stage: string;
  price_kind: string;
  unit: string;
  price_usd: string;
};

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

async function findPrices(client: PoolClient, usage: ExternalApiUsage): Promise<PriceRow[]> {
  if (!usage.provider || !usage.model) return [];
  const priceKinds = ['base'];
  if (usage.stage === 'stt' && asNumber(usage.keytermCount) > 0) {
    priceKinds.push('addon_keyterm_prompting');
  }
  const result = await client.query<PriceRow>(
    `
      select distinct on (price_kind, unit) stage, price_kind, unit, price_usd
      from provider_prices
      where provider = $1
        and model = $2
        and stage = $3
        and price_kind = any($4)
        and effective_from <= now()
        and (effective_to is null or effective_to > now())
      order by price_kind, unit, effective_from desc
    `,
    [usage.provider, usage.model, usage.stage, priceKinds],
  );
  return result.rows;
}

function quantityForUnit(usage: ExternalApiUsage, unit: string): number {
  switch (unit) {
    case 'audio_minute':
      return asNumber(usage.providerAudioDurationSec ?? usage.audioDurationSec) / 60;
    case 'audio_second':
      return asNumber(usage.providerAudioDurationSec ?? usage.audioDurationSec);
    case 'input_1m_tokens':
      return Math.max(asNumber(usage.promptTokens) - asNumber(usage.cachedPromptTokens), 0) / 1_000_000;
    case 'cached_input_1m_tokens':
      return asNumber(usage.cachedPromptTokens) / 1_000_000;
    case 'output_1m_tokens':
      return asNumber(usage.completionTokens) / 1_000_000;
    case 'reasoning_1m_tokens':
      return asNumber(usage.reasoningTokens) / 1_000_000;
    case 'input_1m_chars':
      return asNumber(usage.inputTextChars) / 1_000_000;
    case 'input_1k_chars':
      return asNumber(usage.inputTextChars) / 1_000;
    default:
      return 0;
  }
}

export async function calculateEstimatedCostUsd(client: PoolClient, usage: ExternalApiUsage): Promise<number> {
  const prices = await findPrices(client, usage);
  const total = prices.reduce((sum, price) => {
    const quantity = quantityForUnit(usage, price.unit);
    return sum + quantity * Number(price.price_usd);
  }, 0);
  return Number(total.toFixed(8));
}
