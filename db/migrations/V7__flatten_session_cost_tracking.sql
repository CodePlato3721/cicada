-- 这份内容原本想直接改在 V6 里（因为 V2~V6 当时确实没有合并进 main 的 git 历史），
-- 但事后发现判断错了一个前提：迁移历史跟着的是"实际那台服务器的数据库"，不是
-- "main 分支的 git 历史"——开发这个 TimescaleDB 功能期间，有人在服务器上手动
-- checkout 过这个 feature 分支、手动跑过一次 `npm run migrate`（没有先
-- `git pull origin main`），已经把 V2~V6（包括旧的、创建 daily_usage_cost 表的
-- V6）真的应用到了生产库、记进了 flyway_schema_history。所以 V6 不能再原地改内容
-- （改了 checksum 对不上，下次部署 `npm run migrate` 会直接 validate 失败、整个
-- 部署中断），只能新开 V7 来撤销 + 补上真正要的改动。
--
-- 教训：往后判断"这个版本号能不能原地改"，标准是"生产库的 flyway_schema_history
-- 里有没有记录过"，不是"main 分支的 git 历史里有没有"——手动在服务器上跑
-- `npm run migrate`（README「部署到服务器（手动）」那节）时人也要留意自己当时
-- checkout 的是哪个分支，不是只有走 `main` 自动部署才会让生产库产生迁移记录。
--
-- 下面撤销 V6 创建的 daily_usage_cost 表，再补上原计划要在 V6 里做的两处改动
-- （具体设计取舍见 CLAUDE.md「trans_sessions 的 provider/model 六个扁平字段」
-- 一节，这里不重复）。
drop table if exists daily_usage_cost;

alter table trans_sessions drop column usage_breakdown;
alter table trans_sessions add column stt_provider text;
alter table trans_sessions add column stt_model text;
alter table trans_sessions add column llm_provider text;
alter table trans_sessions add column llm_model text;
alter table trans_sessions add column tts_provider text;
alter table trans_sessions add column tts_model text;

alter table daily_guild_usage add column estimated_cost_usd numeric(12, 8) not null default 0;

comment on column daily_guild_usage.estimated_cost_usd is '当天这个 guild 的估算总花费，session 结束时增量累加（finalizeSessionLedger），不是像 stt_seconds/text_chars 那样从 Redis 实时快照——花费本来就只在 session 结束那一刻算一次，没有更早的中间值可以同步';
