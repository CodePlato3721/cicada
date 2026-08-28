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

Billing 相关数据(`billing_accounts`/`provider_prices`/`daily_guild_usage`/`billing_session_ledger`)存在 Postgres,`DATABASE_URL` 是必填项(`src/config.ts` 里没有它直接启动报错),bot 启动时也会先检查数据库连通(`ensureDatabaseReady`),连不上直接起不来——这个跟 Redis 不一样,不是可选依赖。

**方式一:Docker(推荐)**
```bash
docker compose up -d postgres
```
用的是仓库根目录的 `docker-compose.yml`,起一个 `cicada-postgres` 容器,数据存在具名 volume 里,重启容器不丢数据。

**方式二**:自己装本地 Postgres 17,建好库/用户,跟 `.env.example` 里 `DATABASE_URL` 默认值(`postgresql://cicada:cicada_dev_password@127.0.0.1:5432/cicada`)对应即可,或者改成你自己的连接串。

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

想看当前有哪些表、要不要补价格数据,用 `billing-cli`(schema 建表不归它管了,只剩数据层面的操作):
```bash
npm run billing -- seed-prices   # 灌入 src/adapter/out/db/seed-prices.ts 里的供应商价格数据(幂等,重复跑不会出错)
npm run billing -- summary       # 看有哪些 guild 账户
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
