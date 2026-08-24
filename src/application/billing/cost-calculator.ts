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

// 一场会话（/join 到 /leave）的原始用量按 (stage, provider, model) 分组存在 Redis 里
// （session.ts 的 accumulateSessionUsage/readSessionUsageBreakdown），/leave 时读出来
// 算这场会话的 estimated_cost_usd，写进 billing_session_ledger。直接复用上面
// calculateEstimatedCostUsd（同一份 provider_prices 定价逻辑），每组拼一个"够用"的
// ExternalApiUsage 形状喂给它——不重新实现一遍定价规则。
//
// 已知的简化（不是漏做，是刻意先不做）：这里没有还原 STT keyterm prompting 的 addon
// 计费（provider_prices 里 price_kind='addon_keyterm_prompting' 那部分）——累加器目前
// 只按 stage|provider|model 分组，不区分"这段音频用没用 keyterm prompting"，所以这里
// 算出来的会话成本只包含 base 价格，偏低估。keyterm 场景当前只在源语言锁定中文时启用
// （见 CLAUDE.md），影响范围有限；真要精确算再给累加器加一个维度。
export interface SessionCostBreakdownEntry {
  stage: string;
  provider: string;
  model: string;
  estimatedCostUsd: number;
}

export async function calculateSessionCostUsd(
  client: PoolClient,
  groups: Array<{ stage: string; provider: string; model: string; metrics: Record<string, number> }>,
): Promise<{ totalCostUsd: number; breakdown: SessionCostBreakdownEntry[] }> {
  const breakdown: SessionCostBreakdownEntry[] = [];
  let totalCostUsd = 0;

  for (const group of groups) {
    const usage: ExternalApiUsage = {
      stage: group.stage as ExternalApiUsage['stage'],
      provider: group.provider,
      model: group.model,
      audioDurationSec: group.metrics.audioDurationSec,
      promptTokens: group.metrics.promptTokens,
      cachedPromptTokens: group.metrics.cachedPromptTokens,
      completionTokens: group.metrics.completionTokens,
      reasoningTokens: group.metrics.reasoningTokens,
      inputTextChars: group.metrics.inputTextChars,
    };
    const estimatedCostUsd = await calculateEstimatedCostUsd(client, usage);
    breakdown.push({ stage: group.stage, provider: group.provider, model: group.model, estimatedCostUsd });
    totalCostUsd += estimatedCostUsd;
  }

  return { totalCostUsd: Number(totalCostUsd.toFixed(8)), breakdown };
}
