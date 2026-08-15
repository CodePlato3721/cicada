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
3. `npm run deploy-commands`——把 `/join`/`/leave`/`/lang`/`/game`/`/test` 注册到 `.env` 里 `DISCORD_TEST_GUILD_ID` 指定的测试服务器(必须先设这个变量,不然报错提示)
4. `npm start`——bot 上线,去测试服务器打 `/join` 验证

**这一步经常忘、但很关键**:改了/新增了斜杠命令(比如新增一个命令文件、改了某个命令的参数),都要重新跑一次 `npm run deploy-commands`,不然 Discord 那边看不到新命令——改代码不会自动同步命令定义。

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
