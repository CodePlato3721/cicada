import 'dotenv/config';
import { dbPool, ensureDatabaseReady } from './adapter/out/db/client.js';
import { migrateBillingSchema } from './adapter/out/db/migrations.js';
import { seedProviderPrices } from './adapter/out/db/seed-prices.js';

function usage(): void {
  console.log(`Usage:
  npm run billing -- migrate
  npm run billing -- seed-prices
  npm run billing -- summary
  npm run billing -- guild <guildId>
  npm run billing -- cost <guildId> [today]
  npm run billing -- events <guildId> [limit]
  npm run billing -- ledger <guildId> [limit]
  npm run billing -- credit <guildId> <amountUsd> [description]
  npm run billing -- plan <guildId> <free|server>
  npm run billing -- suspend <guildId>
  npm run billing -- resume <guildId>`);
}

async function ensureAccount(guildId: string): Promise<string> {
  const result = await dbPool.query<{ id: string }>(
    `
      insert into billing_accounts (guild_id)
      values ($1)
      on conflict (guild_id) do update set updated_at = now()
      returning id
    `,
    [guildId],
  );
  return result.rows[0].id;
}

async function main(): Promise<void> {
  await ensureDatabaseReady();
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case 'migrate':
      await migrateBillingSchema();
      console.log('Billing schema migrated.');
      break;

    case 'seed-prices': {
      const count = await seedProviderPrices();
      console.log(`Seeded ${count} provider price(s).`);
      break;
    }

    case 'summary': {
      const result = await dbPool.query(`
        select
          count(*)::int as accounts,
          coalesce(sum(balance_usd), 0)::text as total_balance_usd,
          count(*) filter (where status = 'suspended')::int as suspended_accounts
        from billing_accounts
      `);
      console.table(result.rows);
      break;
    }

    case 'guild': {
      const [guildId] = args;
      if (!guildId) throw new Error('guildId is required');
      await ensureAccount(guildId);
      const result = await dbPool.query(
        `
          select a.guild_id, a.plan_id, a.status, a.balance_usd, a.created_at, a.updated_at,
                 coalesce(d.voice_seconds, 0) as today_voice_seconds,
                 coalesce(d.text_chars, 0) as today_text_chars
          from billing_accounts a
          left join daily_usage_counters d on d.guild_id = a.guild_id and d.usage_date = current_date
          where a.guild_id = $1
        `,
        [guildId],
      );
      console.table(result.rows);
      break;
    }

    case 'cost': {
      const [guildId, range] = args;
      if (!guildId) throw new Error('guildId is required');
      if (range && range !== 'today') throw new Error('usage: cost <guildId> [today]');

      const dateFilter = range === 'today' ? 'and created_at >= current_date' : '';
      const total = await dbPool.query(
        `
          select coalesce(sum(estimated_cost_usd), 0)::numeric(12, 8)::text as total_cost_usd
          from usage_events
          where guild_id = $1
          ${dateFilter}
        `,
        [guildId],
      );
      const breakdown = await dbPool.query(
        `
          select
            stage,
            provider,
            model,
            coalesce(sum(estimated_cost_usd), 0)::numeric(12, 8)::text as cost_usd,
            count(*)::int as event_count
          from usage_events
          where guild_id = $1
          ${dateFilter}
          group by stage, provider, model
          order by stage, provider, model
        `,
        [guildId],
      );

      console.log(`Total cost${range === 'today' ? ' today' : ''}: $${total.rows[0].total_cost_usd}`);
      console.table(breakdown.rows);
      break;
    }

    case 'events': {
      const [guildId, limit = '50'] = args;
      if (!guildId) throw new Error('guildId is required');
      const result = await dbPool.query(
        `
          select created_at, stage, provider, model, user_id, sequence, source_lang, target_lang,
                 quantity_audio_seconds, quantity_text_chars, prompt_tokens, cached_prompt_tokens,
                 completion_tokens, reasoning_tokens, keyterm_count, estimated_cost_usd
          from usage_events
          where guild_id = $1
          order by created_at desc
          limit $2
        `,
        [guildId, Number(limit)],
      );
      console.table(result.rows);
      break;
    }

    case 'ledger': {
      const [guildId, limit = '50'] = args;
      if (!guildId) throw new Error('guildId is required');
      const result = await dbPool.query(
        `
          select l.created_at, l.type, l.amount_usd, l.description, l.usage_event_id
          from billing_ledger l
          join billing_accounts a on a.id = l.account_id
          where a.guild_id = $1
          order by l.created_at desc
          limit $2
        `,
        [guildId, Number(limit)],
      );
      console.table(result.rows);
      break;
    }

    case 'credit': {
      const [guildId, amount, ...descriptionParts] = args;
      if (!guildId || !amount) throw new Error('guildId and amountUsd are required');
      const accountId = await ensureAccount(guildId);
      const amountUsd = Number(amount);
      if (!Number.isFinite(amountUsd) || amountUsd <= 0) throw new Error('amountUsd must be a positive number');
      const description = descriptionParts.join(' ') || 'manual credit';
      const client = await dbPool.connect();
      try {
        await client.query('begin');
        await client.query(
          `insert into billing_ledger (account_id, type, amount_usd, description) values ($1, 'credit', $2, $3)`,
          [accountId, amountUsd, description],
        );
        await client.query(
          `update billing_accounts set balance_usd = balance_usd + $2, updated_at = now() where id = $1`,
          [accountId, amountUsd],
        );
        await client.query('commit');
      } catch (err) {
        await client.query('rollback').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      console.log(`Credited ${guildId} $${amountUsd.toFixed(2)}.`);
      break;
    }

    case 'plan': {
      const [guildId, planId] = args;
      if (!guildId || !['free', 'server'].includes(planId)) throw new Error('usage: plan <guildId> <free|server>');
      await ensureAccount(guildId);
      await dbPool.query(`update billing_accounts set plan_id = $2, updated_at = now() where guild_id = $1`, [guildId, planId]);
      console.log(`Set ${guildId} plan to ${planId}.`);
      break;
    }

    case 'suspend':
    case 'resume': {
      const [guildId] = args;
      if (!guildId) throw new Error('guildId is required');
      await ensureAccount(guildId);
      const status = command === 'suspend' ? 'suspended' : 'active';
      await dbPool.query(`update billing_accounts set status = $2, updated_at = now() where guild_id = $1`, [guildId, status]);
      console.log(`Set ${guildId} status to ${status}.`);
      break;
    }

    default:
      usage();
      process.exitCode = command ? 1 : 0;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => dbPool.end());
