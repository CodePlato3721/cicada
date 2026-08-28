import 'dotenv/config';
import { dbPool, ensureDatabaseReady } from './adapter/out/db/client.js';
import { seedProviderPrices } from './adapter/out/db/seed-prices.js';
import { remainingForPlan } from './application/billing/billing-service.js';

function usage(): void {
  console.log(`Usage:
  npm run billing -- seed-prices
  npm run billing -- reset --yes-drop-everything
  npm run billing -- summary
  npm run billing -- guild <guildId>
  npm run billing -- sessions <guildId> [limit]
  npm run billing -- credit <guildId> <amountUsd> [description]
  npm run billing -- plan <guildId> <free|server>
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

    // 全量重置：drop schema public cascade 把 db/migrations/ 建的所有表/索引/extension
    // 一次性清空（不用一张张手写 drop table，也不会漏掉以后新加的表），再 create schema
    // public 建一个空的、当前连接用的角色自动是 owner，不需要额外 grant。schema 重建
    // 不在这里做——这个 CLI 不再拥有"建表"这个能力（那是 Flyway 的职责，见 db/migrations/
    // 和 scripts/migrate-db.ts），drop 完之后需要的人自己跑 `npm run migrate` 重建，再
    // 按需跑 `npm run billing -- seed-prices`。只在"没有真实用户数据、可以全部丢弃"的
    // 场景用（比如当前还没上线），要求显式传 --yes-drop-everything，打错命令不会误删。
    // 副作用：Flyway 自己的历史表 flyway_schema_history 也在 public schema 里，一起被
    // 清空，所以之后 `npm run migrate` 会把 V1 当全新环境正常跑一遍（不需要、也不能再
    // baseline）——这正是 reset 想要的效果，不是需要额外处理的边界情况。
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
      // stt_seconds_remaining/text_chars_remaining 是物化列（billing-service.js 的
      // syncDailyUsageToDb 在每次它本来就要跑的低频同步点顺手写好），这里直接读，
      // 不现算——NULL 代表 server 套餐这一项不限量，显示成 'unlimited'。
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
      // 2026-08-23：lifetime_cost_usd 是"累计估算成本"（只增不减），不是可花的钱包
      // 余额,这个命令已经没有它原本"充值"的意义,保留下来纯粹是手工调整/勾账用途
      // (比如发现 billing_session_ledger 少算了一场会话,手动补一笔)。billing_ledger
      // 表已经整个删掉(不再是 pay-as-you-go 产品,没有流水可记),这里不再写审计行,
      // 直接改 lifetime_cost_usd 本身。
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
      if (!guildId || !['free', 'server'].includes(planId)) throw new Error('usage: plan <guildId> <free|server>');
      await ensureAccount(guildId);
      // 换套餐会改变上限，剩余额度物化列要跟着重算一次，不然要等下一次 60 秒定时同步
      // 才会追上——那期间 guild 命令会显示按旧套餐算出来的剩余量。用今天已用量（没有
      // 就是 0，比如换套餐时这个 guild 还没在线）重算一次，不是每次读的时候都现算。
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
