import 'dotenv/config';
import { dbPool, ensureDatabaseReady } from './adapter/out/db/client.js';
import { seedProviderPrices } from './adapter/out/db/seed-prices.js';
import { remainingForPlan } from './application/billing/billing-service.js';
import { BILLING_PLANS } from './application/billing/plans.js';

const PLAN_IDS = Object.keys(BILLING_PLANS);

function usage(): void {
  console.log(`Usage:
  npm run billing -- seed-prices
  npm run billing -- reset --yes-drop-everything
  npm run billing -- summary
  npm run billing -- guild <guildId>
  npm run billing -- sessions <guildId> [limit]
  npm run billing -- credit <guildId> <amountUsd> [description]
  npm run billing -- plan <guildId> <${PLAN_IDS.join('|')}>
  npm run billing -- suspend <guildId>
  npm run billing -- resume <guildId>

Note: schema migrations moved to Flyway (see db/migrations/, run via "npm run migrate") —
this CLI no longer has a "migrate" subcommand. "reset" only drops the schema now; run
"npm run migrate" afterwards to rebuild it.

Note: usage_events/billing_ledger tables were dropped on 2026-08-23 (per-call DB writes
were too high-frequency, see CLAUDE.md; and this product isn't pay-as-you-go, so there's
no recharge/spend ledger to track). Per-call audit info now lives in local JSONL files
(EVENTS_DIR); cost is aggregated once per session into billing_session_ledger — use
"sessions" to inspect it. Plan upgrade/downgrade history isn't tracked in a table yet
(see CLAUDE.md — deliberately deferred, not forgotten).`);
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
    case 'seed-prices': {
      const count = await seedProviderPrices();
      console.log(`Seeded ${count} provider price(s).`);
      break;
    }

    case 'reset': {
      if (!args.includes('--yes-drop-everything')) {
        throw new Error('This drops every billing table and all data. Re-run as: npm run billing -- reset --yes-drop-everything');
      }
      console.log('Dropping public schema (all tables, all data)...');
      await dbPool.query('drop schema public cascade; create schema public;');
      console.log('Schema dropped. Next: `npm run migrate` to rebuild it, then `npm run billing -- seed-prices` if you need provider prices back.');
      break;
    }

    case 'summary': {
      const result = await dbPool.query(`
        select
          count(*)::int as accounts,
          coalesce(sum(lifetime_cost_usd), 0)::text as total_lifetime_cost_usd,
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
      const result = await dbPool.query<{
        guild_id: string;
        plan_id: string;
        status: string;
        lifetime_cost_usd: string;
        stt_seconds_remaining: string | null;
        text_chars_remaining: number | null;
        created_at: string;
        updated_at: string;
        today_stt_seconds: string;
        today_text_chars: string;
      }>(
        `
          select a.guild_id, a.plan_id, a.status, a.lifetime_cost_usd,
                 a.stt_seconds_remaining, a.text_chars_remaining,
                 a.created_at, a.updated_at,
                 coalesce(d.stt_seconds, 0) as today_stt_seconds,
                 coalesce(d.text_chars, 0) as today_text_chars
          from billing_accounts a
          left join daily_guild_usage d on d.guild_id = a.guild_id and d.usage_date = current_date
          where a.guild_id = $1
        `,
        [guildId],
      );
      const row = result.rows[0];
      console.table([
        {
          ...row,
          stt_seconds_remaining: row.stt_seconds_remaining ?? 'unlimited',
          text_chars_remaining: row.text_chars_remaining ?? 'unlimited',
        },
      ]);
      break;
    }

    case 'sessions': {
      const [guildId, limit = '20'] = args;
      if (!guildId) throw new Error('guildId is required');
      const result = await dbPool.query(
        `
          select session_started_at, session_ended_at, duration_seconds, estimated_cost_usd, usage_breakdown
          from billing_session_ledger
          where guild_id = $1
          order by session_started_at desc
          limit $2
        `,
        [guildId, Number(limit)],
      );
      console.table(result.rows);
      break;
    }

    case 'credit': {
      const [guildId, amount] = args;
      if (!guildId || !amount) throw new Error('guildId and amountUsd are required');
      const accountId = await ensureAccount(guildId);
      const amountUsd = Number(amount);
      if (!Number.isFinite(amountUsd)) throw new Error('amountUsd must be a number');
      await dbPool.query(`update billing_accounts set lifetime_cost_usd = lifetime_cost_usd + $2, updated_at = now() where id = $1`, [
        accountId,
        amountUsd,
      ]);
      console.log(`Adjusted ${guildId} lifetime_cost_usd by $${amountUsd.toFixed(2)}.`);
      break;
    }

    case 'plan': {
      const [guildId, planId] = args;
      if (!guildId || !PLAN_IDS.includes(planId)) throw new Error(`usage: plan <guildId> <${PLAN_IDS.join('|')}>`);
      await ensureAccount(guildId);
      const usageResult = await dbPool.query<{ stt_seconds: string; text_chars: string }>(
        `select stt_seconds, text_chars from daily_guild_usage where guild_id = $1 and usage_date = current_date`,
        [guildId],
      );
      const used = usageResult.rows[0] ?? { stt_seconds: '0', text_chars: '0' };
      const { sttSecondsRemaining, textCharsRemaining } = remainingForPlan(planId, Number(used.stt_seconds), Number(used.text_chars));
      await dbPool.query(
        `update billing_accounts set plan_id = $2, stt_seconds_remaining = $3, text_chars_remaining = $4, updated_at = now() where guild_id = $1`,
        [guildId, planId, sttSecondsRemaining, textCharsRemaining],
      );
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
