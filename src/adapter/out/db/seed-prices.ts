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
  // 2026-08-23 补：azure/conversation 之前完全没配价格（f3a16e0 接入 STT 适配器时漏掉了
  // 这一步），954 个事件全部记成 $0（见 CLAUDE.md）。$0.01666667/audio_second = $1/小时，
  // 是 Azure Speech Services 官网挂牌的 Standard 实时转写（Speech to Text, real-time）价格，
  // 项目走的 `speech/recognition/conversation/cognitiveservices/v1` 就是这个标准实时识别端点，
  // 不是 custom/batch，对应这一档。跟 Azure Portal 实际账单($1.16, stt+tts 合计)反推出来的
  // 单价对不完全对得上（按这个官网价算出来的 stt+tts+llm 总和约 $1.02，比实际账单低），
  // 差额原因还没查——按用户要求这里用官网挂牌价，不用反推值，实际使用前仍建议去
  // Azure Portal 定价页核对这台账号当前生效的价格档位/区域价差。
  { provider: 'azure', model: 'conversation', stage: 'stt', priceKind: 'base', unit: 'audio_second', priceUsd: 0.00027778 },
  { provider: 'deepseek', model: 'deepseek-v4-flash', stage: 'llm', priceKind: 'base', unit: 'cached_input_1m_tokens', priceUsd: 0.014 },
  { provider: 'deepseek', model: 'deepseek-v4-flash', stage: 'llm', priceKind: 'base', unit: 'input_1m_tokens', priceUsd: 0.44 },
  { provider: 'deepseek', model: 'deepseek-v4-flash', stage: 'llm', priceKind: 'base', unit: 'output_1m_tokens', priceUsd: 1.32 },
  // 2026-08-26 补：新增翻译供应商 openai/gpt-5-nano，价格取自 developers.openai.com/api/docs/models/gpt-5-nano。
  // 没有单独的 reasoning_1m_tokens 档——GPT-5 系列的 reasoning token 按 output 单价计费，
  // 不是独立单价，所以这里不需要额外一条 reasoning_1m_tokens 记录（跟 deepseek 那三条只有
  // input/cached_input/output 三档是同一个理由）。
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

