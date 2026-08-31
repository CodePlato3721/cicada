-- 需要生产 droplet 上已经装好 timescaledb-2-postgresql-17（apt 包）、跑过
-- timescaledb-tune、重启过 postgresql 服务、shared_preload_libraries 里带上
-- timescaledb，这条 CREATE EXTENSION 才能成功——这部分是运维操作，不在 Flyway
-- 迁移文件职责范围内，见 README「部署到服务器」一节的一次性安装步骤。
--
-- 显式 schema public，跟 V1 pgcrypto 那条一致的理由：生产库 cicada 角色的
-- search_path 解析不到默认 schema。
create extension if not exists timescaledb schema public;
