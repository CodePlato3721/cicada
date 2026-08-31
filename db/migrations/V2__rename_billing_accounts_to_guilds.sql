-- billing_accounts 早就不只是"计费账户"了——已经在存 stt_seconds_remaining/
-- text_chars_remaining 这类运行时状态，现在还要加一个跟计费完全无关的
-- transcript_retention_enabled 开关（见下）。继续叫 billing_accounts 名不副实，
-- 改成 guilds——它真实的定位是"每个 guild 一行的账户/配置汇总表"。
--
-- 计费本身的逻辑（套餐定价、成本计算，src/application/billing/）不受影响，还是
-- 叫 billing；这次只改这张表和管理它的 CLI（billing-cli.ts -> manage-cli.ts）的名字，
-- 不是把整个计费模块改名。
alter table billing_accounts rename to guilds;

-- 主键/唯一约束/check 约束的自动生成名字不会随表改名自动更新，手动跟着改一遍，
-- 避免以后 \d guilds 看到一堆 billing_accounts_* 的历史包袱。RENAME CONSTRAINT
-- 对主键/唯一约束会连带把背后的索引也一起改名，不需要另外 ALTER INDEX。
alter table guilds rename constraint billing_accounts_pkey to guilds_pkey;
alter table guilds rename constraint billing_accounts_guild_id_key to guilds_guild_id_key;
alter table guilds rename constraint billing_accounts_plan_id_check to guilds_plan_id_check;
alter table guilds rename constraint billing_accounts_status_check to guilds_status_check;

-- 对话素材（transcript_events，见 V5）默认不采集，只有显式为某个 guild 打开这个
-- 开关才会留存转写文本——语音转写内容属于用户说话内容的持久化留存，不能默认全量
-- 收集。开关用 `npm run manage -- transcripts <guildId> on|off` 管理。
alter table guilds add column transcript_retention_enabled boolean not null default false;
