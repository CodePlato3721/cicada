-- V2~V6 都还没合并进 main、没有部署到任何生产/共享环境（只在本地 Docker Postgres
-- 跑过），所以这里直接在原地调整 V5/新表设计，不是另开一条"撤销记录"式的迁移——
-- 跟 V1 baseline 那种"生产已有旧结构、必须冻结快照"的处境不一样，V5 现在改了照样
-- 能让全新环境和（还没发生过的）生产部署产出同一份最终结构，不存在历史包袱。
--
-- 背景：最初想法是 usage_breakdown（trans_sessions 里一个 jsonb 数组，按
-- stage/provider/model 存每一项的花费）+ 单独一张 daily_usage_cost 汇总表，
-- 每天用 pm2 cron job（src/rollup-daily-usage.ts）从 usage_events 批量算一遍花费。
-- 讨论后放弃了这个方向，换成更简单的方案：
--   1) trans_sessions 不再存整个 usage_breakdown 数组，只留"这个 session 的 stt/
--      llm/tts 三个环节各自用了哪个供应商/模型"这六个扁平字段——不需要知道每个环节
--      具体花了多少钱才能对账，够用了；真正的总花费仍然是 estimated_cost_usd 这一
--      个数（这一列本来就跟 usage_breakdown 是两回事，不受这次改动影响）。
--   2) 花费不再单独起一张 daily_usage_cost 表、不再需要 cron job 定时聚合——
--      daily_guild_usage（V1 就有，本来就在会话结束/日期翻转/配额用尽时实时同步）
--      直接加一列 estimated_cost_usd，跟 stt_seconds/text_chars 用同一套实时更新
--      机制，"细粒度做到 guild+day 一行就够，不做全局/按 provider 拆分的汇总表"。
--   3) 因为 daily_usage_cost 从未部署到任何环境，创建它的旧 V6 迁移文件直接删除，
--      这份新 V6 补上真正要的两处改动，不留"建了又立刻删"的历史痕迹。
--
-- stt/llm/tts_provider/model 六个字段在 finalizeSessionLedger 里从 Redis 累计的
-- usage 分组里各取一条——STT/LLM 供应商实际上是部署时通过环境变量固定的（不会在
-- 一个 session 内变化），但 TTS 是按目标语言动态路由的（见 CLAUDE.md「供应商可
-- 切换」一节），如果一个 session 中途用 /lang、/config 切过目标语言、导致 TTS
-- 供应商也跟着变了，这里只会留下其中一个（哪个由 Redis 累计时的分组顺序决定，
-- 不保证是"最后用的那个"）——这是"从数组收窄成单值"必然要接受的取舍,不是 bug。
alter table trans_sessions drop column usage_breakdown;
alter table trans_sessions add column stt_provider text;
alter table trans_sessions add column stt_model text;
alter table trans_sessions add column llm_provider text;
alter table trans_sessions add column llm_model text;
alter table trans_sessions add column tts_provider text;
alter table trans_sessions add column tts_model text;

alter table daily_guild_usage add column estimated_cost_usd numeric(12, 8) not null default 0;

comment on column daily_guild_usage.estimated_cost_usd is '当天这个 guild 的估算总花费，session 结束时增量累加（finalizeSessionLedger），不是像 stt_seconds/text_chars 那样从 Redis 实时快照——花费本来就只在 session 结束那一刻算一次，没有更早的中间值可以同步';
