# cicada

Discord 实时语音翻译 Bot。`/join` 后自动监听频道语音,本地 VAD 切句 → STT → 翻译 → TTS 播回频道。

架构/设计决策看 [CLAUDE.md](./CLAUDE.md),这份文档只管"要跑起来该敲什么命令"。

---

## 命令速查表

| 要做什么 | 命令 |
|---|---|
| 本地启动 bot | `npm start` |
| 装依赖 | `npm install` |
| 注册斜杠命令(日常开发,秒级生效,只在 `DISCORD_TEST_GUILD_ID` 那个服务器可见) | `npm run deploy-commands` |
| 注册斜杠命令(全局,最多 1 小时生效,所有装了 bot 的服务器可见) | `npm run deploy-commands:global` |
| 抓取新的游戏黑话/术语(生成待审核草稿) | `node scripts/scrape-terms.js <分类id 或 --all>` |
| 把审核过的术语草稿合并进正式词典 | `npm run merge-terms <分类id>` |
| 给已有词条补充新语言译名(生成待审核补丁) | `npm run scrape-lang <分类id 或 --all> <语言码...>` |
| 把审核过的语言补丁合并进正式词典 | `npm run merge-lang <分类id> <语言码...>` |

---

## 第一次跑起来

1. `npm install`
2. 复制 `.env.example` 为 `.env`,按注释填好各项(至少要有 `DISCORD_BOT_TOKEN`、`DISCORD_CLIENT_ID`、一个翻译/STT 供应商的 API Key;TTS 按目标语言路由到 Deepgram/Azure,想用哪个目标语言就填对应供应商的 key,见 `.env.example` 里的说明)
3. `npm run deploy-commands`——把 `/join`/`/leave`/`/lang`/`/game`/`/reset`/`/config`/`/test` 注册到 `.env` 里 `DISCORD_TEST_GUILD_ID` 指定的测试服务器(必须先设这个变量,不然报错提示)
4. `npm start`——bot 上线,去测试服务器打 `/join` 验证
5. (可选)想本地测试翻译缓存,按下面「本地 Redis」一节起一个本地 Redis 并配好 `REDIS_URL`——不装也能跑,缓存层会自动降级,见下文

**这一步经常忘、但很关键**:改了/新增了斜杠命令(比如新增一个命令文件、改了某个命令的参数),都要重新跑一次 `npm run deploy-commands`,不然 Discord 那边看不到新命令——改代码不会自动同步命令定义。

---

## 本地 Postgres(数据库,必需)

`guilds`/`provider_prices`/`daily_guild_usage`/`trans_sessions`(账户与计费 + 对话素材的 session 分组,一次 `/join`~`/leave` 一行,`/join` 时插入、会话中/结束时增量 update,不是一次写完,详见 CLAUDE.md)、`usage_events`(按次 STT/翻译/TTS 调用审计)、`transcript_events`(对话素材原文/译文,挂 `session_id` 到 `trans_sessions`)都存在 Postgres,`DATABASE_URL` 是必填项(`src/config.ts` 里没有它直接启动报错),bot 启动时也会先检查数据库连通(`ensureDatabaseReady`),连不上直接起不来——这个跟 Redis 不一样,不是可选依赖。`usage_events`/`transcript_events` 是 TimescaleDB hypertable(按次写入频率高,普通表扛不住,历史上因此被删过一次,详见 CLAUDE.md),数据库必须装了 TimescaleDB 扩展。

**方式一:Docker(推荐)**
```bash
docker compose up -d postgres
```
用的是仓库根目录的 `docker-compose.yml`,镜像是 `timescale/timescaledb:latest-pg17`(不是裸 `postgres:17`),起一个 `cicada-postgres` 容器,数据存在具名 volume 里,重启容器不丢数据。

如果你的本地 volume 是在这次引入 TimescaleDB 之前建的(还是裸 Postgres 镜像的数据),换镜像不是原地升级,需要手动导出/导入一遍:
```bash
# 换镜像之前,容器还是旧的 postgres:17 时先导出
docker exec cicada-postgres pg_dump -U cicada -d cicada > cicada-backup.sql

# 改完 docker-compose.yml 的镜像后重建容器(会用新镜像,原 volume 数据对新镜像里的
# TimescaleDB 而言不认识,等于全新库)
docker compose up -d --force-recreate postgres

# 等 Postgres 启动完成后导入回去
docker exec -i cicada-postgres psql -U cicada -d cicada < cicada-backup.sql
```
全新环境(还没起过旧容器)不用管这一段,直接 `docker compose up -d postgres` 起出来就已经是 TimescaleDB 镜像。

**方式二**:自己装本地 Postgres 17 + TimescaleDB 扩展,建好库/用户,跟 `.env.example` 里 `DATABASE_URL` 默认值(`postgresql://cicada:cicada_dev_password@127.0.0.1:5432/cicada`)对应即可,或者改成你自己的连接串。

起好之后,**第一次用/schema 有更新时都要跑一次迁移**(schema 用 Flyway 管理,版本化迁移文件在 `db/migrations/`,设计背景见 CLAUDE.md「数据库 schema 管理」一节):
```bash
npm run migrate
```
Windows 本机跑这个命令会报错提示改用 Docker——`npm run migrate` 背后调的是 Flyway 官方命令行工具,只自动装了 Linux/macOS 版本(生产 droplet 是 Linux),Windows 本地开发改用 Flyway 官方 Docker 镜像:
```bash
docker run --rm -v "$(pwd)/db/migrations:/flyway/sql" flyway/flyway `
  -url=jdbc:postgresql://host.docker.internal:5432/cicada -user=cicada -password=cicada_dev_password `
  -locations=filesystem:/flyway/sql migrate
```

想看当前有哪些表、要不要补价格数据、要不要给某个 guild 开对话素材留存,用 `manage-cli`(schema 建表不归它管了,只剩数据层面的操作;这个 CLI 原名 `billing-cli`,因为管的表已经不只是计费,连带 CLI 一起改了名,详见 CLAUDE.md):
```bash
npm run manage -- seed-prices             # 灌入 src/adapter/out/db/seed-prices.ts 里的供应商价格数据(幂等,重复跑不会出错)
npm run manage -- summary                 # 看有哪些 guild 账户
npm run manage -- transcripts <guildId> on   # 给某个 guild 开启对话素材留存(默认关闭,opt-in)
npm run manage -- transcripts <guildId> off  # 关闭
```

---

## 本地 Redis(翻译缓存,可选)

给翻译环节加了一层 Redis 缓存,目前只覆盖中文源语言:同一句话(经过规范化)命中过缓存就直接返回译文,跳过 LLM 翻译调用。**这是可选依赖**:不装本地 Redis、`.env` 里不配 `REDIS_URL` 也完全不影响 bot 正常跑起来——启动时会打一行 `REDIS_URL not configured, translation cache layer disabled` 的警告日志,自动降级成"没有缓存"的行为,不会报错;Redis 连不上/超时同样只是记日志、跳过缓存,不会拖垮翻译流程。

只有想在本地实际测试"同一句中文说两次,第二次是不是走了缓存"这种效果时,才需要起一个本地 Redis。任选一种方式:

**方式一:Docker(推荐,跨平台一致,这台机器已经装了 Docker Desktop)**
```bash
docker run -d --name cicada-redis -p 6379:6379 redis:latest
```

**方式二:WSL2(Windows 本机没有官方维护的 Redis 发行版,不建议装那些第三方 Windows 移植版)**
```bash
wsl --install   # 已经装过 WSL2 可跳过
# 进入 WSL2 发行版(比如 Ubuntu)之后:
sudo apt update && sudo apt install redis-server
sudo service redis-server start
```

**方式三:macOS**
```bash
brew install redis
brew services start redis
```

起好之后,`.env` 里配:
```
REDIS_URL=redis://127.0.0.1:6379
```

`REDIS_COMMAND_TIMEOUT_MS`(单条 Redis 命令超时,默认 1000ms)和 `TRANSLATE_CACHE_TTL_SECONDS`(缓存条目存活时间,默认 259200 秒/3 天)都有默认值,本地开发一般不用改,具体说明见 `.env.example`。

验证 Redis 本身连通:
```bash
redis-cli ping   # 期望输出 PONG
```

验证缓存在 bot 里真的生效:`/config source:zh target:<任意目标语言>` 设好源/目标语言后,对着同一句中文说两次,第二次的日志里应该出现 `translation cache hit, skipping LLM translation`,而不是走一遍完整的翻译流程。

---

## 本地开发 vs 生产环境:两个 Discord Application

正式 Cicada 和你本地开发用的 bot **必须是两个不同的 Discord Application**(两份不同的 `DISCORD_BOT_TOKEN`/`DISCORD_CLIENT_ID`),不能共用——同一个 token 在服务器和本地同时连 Discord 网关会互相冲突(抢事件、抢语音连接)。

- 生产环境:服务器上的 `.env` 填正式 Cicada app 的凭证,常驻用 pm2 管理
- 本地开发:本地 `.env` 填一个单独的"Cicada Dev" App 的凭证,邀请进同一个测试服务器

改机器人显示名字去 Developer Portal 的 **"机器人"** 页面改**用户名**字段,不是"基本信息"页面的 App 名称——这两个字段互相独立,只改一边不会同步到另一边。

---

## 部署到服务器(手动)

```bash
ssh <用户名>@<droplet IP>
cd /path/to/cicada
git pull origin main
npm install
npm run build   # 项目是 TypeScript,pm2 托管的是 dist/ 下的编译产物,重启前必须先编译
npm run migrate # 跑 Flyway 迁移(db/migrations/),必须在 pm2 restart 之前,见 CLAUDE.md「数据库 schema 管理」
pm2 restart cicada   # 具体进程名/id 用 pm2 list 查
pm2 logs cicada --lines 50   # 确认启动正常
```

`npm run deploy-commands:global` 只需要跑一次(命令确认稳定、要正式对所有服务器开放时),不用每次部署都跑;本地或服务器上跑都行,只要 `.env` 里有对应凭证。

### 一次性:生产 droplet 装 TimescaleDB(只需要做一次)

生产 droplet 上的 Postgres 是 apt 装的裸 Postgres(不是 Docker)。**先用 `pg_lsclusters` 确认实际在跑的版本**,不要想当然假设是某个固定版本——本项目 2026-08-30 第一次给现有生产 droplet 装 TimescaleDB 时才发现,这台机器实际一直跑的是 **Postgres 16**,不是 17(本地开发用的 `timescale/timescaledb:latest-pg17` docker 镜像是 17,两边版本不一致,是历史遗留,不代表生产也是 17——下面命令里的版本号要跟着 `pg_lsclusters` 的实际输出换,不能照抄 17)。

`db/migrations/V3__enable_timescaledb.sql` 的 `create extension timescaledb` 要成功,得先把扩展本体装上、启用、重启服务——这部分是运维操作,不在 Flyway 迁移文件职责范围内,只需要在服务器上做一次(下面以实际版本 16 为例,装的时候把 `16` 换成你 `pg_lsclusters` 看到的版本号):

```bash
# 装前置工具 + 关键一步:注册官方 PGDG(PostgreSQL Global Development Group)apt 源。
# 这一步不能漏——timescaledb 的 apt 包依赖某个较新的 postgresql 小版本,系统自带源
# 通常达不到,会报 "Depends: postgresql-16 (>= x.x) but it is not installable"，
# 只有 PGDG 源才有。
#
# 注意:这一步如果系统还没装过 PGDG 源，apt.postgresql.org.sh 默认会把所有受支持的
# 大版本（比如同时装上 16 和 17）的仓库都注册进去，后续 apt install 时你只指定某个
# 版本的包（比如 timescaledb-2-postgresql-16）本身不会额外装别的版本，但如果不小心
# 装错了版本号的包（比如误装了 postgresql-17），postgresql-common 的 apt hook 会
# 自动新建一个独立集群（默认端口 5433），而不是报错——装完一定要 `pg_lsclusters`
# 确认没有多出一个你没打算要的集群，这台机器内存有限，不需要的空集群应该清掉
# （`pg_dropcluster <version> main --stop`），不要放着不管。
sudo apt install -y gnupg postgresql-common apt-transport-https lsb-release wget
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh

# 装 TimescaleDB 官方 apt 源 + 扩展包(版本号要对应你实际在跑的 Postgres 大版本,
# 见 https://docs.timescale.com/self-hosted/latest/install/installation-linux/ 官方文档)
echo "deb https://packagecloud.io/timescale/timescaledb/ubuntu/ $(lsb_release -c -s) main" | sudo tee /etc/apt/sources.list.d/timescaledb.list
wget --quiet -O - https://packagecloud.io/timescale/timescaledb/gpgkey | sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/timescaledb.gpg
sudo apt update
sudo apt install timescaledb-2-postgresql-16

# 服务器上可能同时存在多个 Postgres 大版本,显式指定 --pg-config 避免 timescaledb-tune
# 猜错/问你选哪个
sudo timescaledb-tune --quiet --yes --pg-config=/usr/lib/postgresql/16/bin/pg_config

# 参数改动需要重启服务才生效——只重启你实际在用的这个集群(cluster 名默认是 main)
sudo systemctl restart postgresql@16-main
```

上面第一步(注册 PGDG 源)可能会顺带把已装的 Postgres 升级到一个更新的小版本(同大版本内的小版本升级,不需要 dump/restore,但会重启服务、有短暂停机)——装之前建议先 `pg_dump "$DATABASE_URL" > backup.sql` 留一份保险。

装完之后正常走上面的部署流程(`npm run migrate` 会把 V3 应用上,建好扩展),不需要额外手动 `create extension`。这一步只在这台 droplet 第一次引入 TimescaleDB 时做一次,以后部署不用重复。

### 一次性:注册每日用量/花费汇总的 pm2 定时任务(只需要做一次)

`src/rollup-daily-usage.ts`(`npm run rollup-usage`)每天把前一天的 `usage_events` 按 `(guild_id, stage, provider, model)` 聚合、算好花费,写进 `daily_usage_cost`(见 `db/migrations/V6`),给报表/看板用,不用每次查询都现算。这是个跑一次就退出的批处理脚本,不是常驻服务——不用系统 crontab,直接用 pm2 自带的 `--cron-restart` 功能注册,跟 cicada 主进程用同一套工具管理,日志统一走 `pm2 logs`:

```bash
pm2 start npm --name cicada-rollup --cron-restart="15 0 * * *" --no-autorestart -- run rollup-usage
pm2 save
```

- `--cron-restart` 是 pm2 内置的"按 cron 表达式定时拉起进程"功能,不是"进程常驻、定时重启"——配合 `--no-autorestart`(跑完正常退出不重启)就是标准的"每天固定时间跑一次、跑完自己退出"效果,不会像 cicada 主进程一样一直占着内存
- `15 0 * * *` 是 UTC 时间每天 00:15 跑(pm2 的 cron 表达式按系统时区解析,这台 droplet 装机默认就是 UTC,`timedatectl` 能确认),晚 15 分钟是留缓冲——项目里所有"天"的切分都是 UTC(`todayUtc()`/`usage_date` 同一个口径),跑太早可能漏掉前一天最后几分钟才落地的调用(单次外部请求最坏卡到 `API_TIMEOUT_MS` 量级,15 分钟绰绰有余)
- 幂等,可以安全重跑:`npm run rollup-usage -- 2026-08-25` 手动传日期能回填/重算某一天(比如这个定时任务哪天没跑成功,事后补跑)
- `pm2 save` 把这个定时任务写进 pm2 的持久化进程列表,droplet 重启后 pm2 恢复进程时会带上它,不需要每次重启服务器手动重新注册
- 排查:`pm2 logs cicada-rollup` 看历史执行日志;`pm2 describe cicada-rollup` 确认 cron 表达式生效

---

## 游戏黑话/术语库维护流程

完整设计背景见 CLAUDE.md「游戏黑话/专有名词术语库」一节,这里只列操作步骤:

1. **抓取**:`node scripts/scrape-terms.js <分类id>`(比如 `heroes`),结果写到 `scripts/drafts/<分类id>.draft.json`,不会直接改词典
2. **人工审核**:直接编辑这份 draft 文件——删掉不要的条目、修正被标记(`flags`)的可疑条目
3. **合并**:`npm run merge-terms <分类id>`,追加进 `src/domain/terminology/<game>.json`
4. 可选:审核完确认没问题,把对应的 draft 文件删掉,避免跟正式词典混淆

新增语言译名(比如给已有词条补韩文/阿拉伯语)走的是另一套流程,因为是"给已有词条加字段"不是"新增词条":

1. `node scripts/scrape-lang.js <分类id> <语言码...>`(比如 `heroes ko ar`),写到 `scripts/drafts/<分类id>.<语言码>.patch.json`
2. 人工审核这份 patch 文件
3. `npm run merge-lang <分类id> <语言码...>`,给对应 `term_id` 补上新语言字段

分类 id 和支持的语言码见 [scripts/wiki-sources.js](./scripts/wiki-sources.js) 和 [scripts/scrape-lang.js](./scripts/scrape-lang.js) 里的 `LANG_HREFLANG`。
