# cicada 项目 Context

## 项目定位

专注游戏领域的实时语音翻译 App,核心场景是 Discord 语音频道里的跨语言玩家组队/开黑沟通。核心链路:`/join` 后自动监听频道内所有人的语音,本地 Silero VAD 实时切句 → Deepgram STT → Groq Llama 翻译 → Deepgram TTS 播回频道;`/leave` 停止监听并退出。

实时翻译:一句话被 VAD 切出来就立即进入翻译流程,同时继续采集下一句,不等整段结束再处理(采集与翻译并行;语音播放本身仍需排队串行,避免多句声音在频道里叠在一起)。

当前范围外(暂不涉及):
- 商业化/订阅/付费逻辑
- 多租户(guild_id → API key 映射)
- 手机 companion app

---

## 核心技术决策

### 服务端语言:Node.js

选择理由:Discord 语音接收(接收多用户音频流、按 SSRC 区分说话人)这个环节,`@discordjs/voice` 是官方维护、文档完整、有生产环境验证的方案。对比 discord.py,语音接收功能长期依赖社区第三方扩展,成熟度不足。这是决定语言选择的核心因素,其余业务逻辑(调用外部 API、异步等待)两个语言都能胜任,不构成决定性差异。

### 核心依赖库
- `discord.js` + `@discordjs/voice`:Discord 连接与语音收发
- Silero VAD:语音活动检测,**本地运行**,不联网,判断"一句话是否说完"

### 供应商可切换
STT/翻译/TTS 三个环节各自通过端口(`src/application/ports/`)与具体供应商解耦,由 `STT_PROVIDER`/`TRANSLATE_PROVIDER`/`TTS_PROVIDER` 环境变量选择实现,换供应商不用改业务代码。当前:
- STT:Deepgram(`nova-3`)
- 翻译:Groq(`llama-3.1-8b-instant`),备用 DeepSeek
- TTS:Deepgram(Aura-2 音色)

---

## 架构流程

```
Discord 语音频道
      │
      ▼
Node.js 服务器
      │
      ├─ discord.js 接收每个用户的 Opus 音频流(按 SSRC 区分说话人)
      ├─ 解码为 PCM
      ├─ Silero VAD 本地切句(检测静音间隔,确认一句话边界)
      │
      ▼
Deepgram Nova-3(STT,联网调用)
      │  → (speaker_id, 原文, 源语言)
      ▼
Groq Llama 3.1 8B Instant(翻译,联网调用)
      │  → 译文
      ▼
Deepgram Aura-2(语音合成,联网调用)
      │
      ▼
返回 Node.js 服务器 → 播放回 Discord 语音频道 / 或输出文字字幕
```

**当前供应商组合:STT/TTS 用 Deepgram,翻译用 Groq(备用 DeepSeek)。** STT/TTS 最初也在 Groq(Whisper + Orpheus),后来切到 Deepgram(Nova-3 + Aura-2);翻译环节继续留在 Groq,理由不变:Llama 3.1 8B Instant 价格($0.05/$0.08 每百万 token)低,且 Groq 的 TTFT 在多份第三方评测中排名第一梯队。

---

## 具体模型与定价参考(建议实际调用前在对应控制台核实最新价格)

| 环节 | 供应商/模型 | 价格 | 备注 |
|---|---|---|---|
| STT | Deepgram nova-3(Pre-Recorded) | 需在 console.deepgram.com 核实 | 项目用法是存好 wav 文件再转录,不是流式 |
| 翻译 | Groq llama-3.1-8b-instant | $0.05/M输入,$0.08/M输出 | 通用小模型;`TRANSLATE_PROVIDER=deepseek` 可切到 DeepSeek 备用 |
| TTS | Deepgram Aura-2 | 需在 console.deepgram.com 核实 | 项目目前只接了英文(`-en`)音色,见下方限制 |

### 已知限制:TTS 目前只支持英语
Deepgram Aura-2 官方还支持 es/de/fr/nl/it/ja 等语言的音色,但项目里(`src/adapter/out/deepgram/tts.js`)目前只验证并接入了英文音色,`TTS_SUPPORTED_LANGS` 只列了 `en`,不支持中文。中文语音播报需要额外引入本地方案(候选:Kokoro-82M,Apache 2.0 可商用,CPU/GPU 均可跑,中文支持较好),这块暂未接入。

---

## Groq 免费额度(翻译环节,注意分维度限制)

- 翻译 LLM:约 30 RPM(每分钟请求数)、6000 TPM(每分钟token数)、每天 1000-14400 次请求(不同来源数字有出入,以控制台实际显示为准)

**注意**:免费额度按维度限制,不是单一总量。VAD 切句过密可能优先触发 RPM/TPM 限制,而不是总请求数限制。单人测试通常够用,多人并发容易触顶。

超出免费额度可绑定信用卡升级 Developer tier,不产生额外费用直到实际用量超出,且解锁更高限额 + 约25%折扣。

STT/TTS 已切到 Deepgram,其额度/计费规则需登录 console.deepgram.com 核实,不再适用上面 Groq 的限制。

---

## VAD 切句注意事项

- VAD 本身运算量极小(毫秒级,CPU 可跑),延迟主要来自"等待静音间隔"这个机制本身,不是算法慢
- 静音判定阈值需要作为可调参数设计,不要硬编码:
  - 阈值过短 → 容易把自然停顿误判为句子结束,翻译支离破碎
  - 阈值过长 → 延迟增加
- 切句粒度直接影响 STT 调用成本(切太碎请求数暴涨),需要平衡"响应速度"与"成本效率"

---

## 游戏黑话/专有名词术语库

### 问题
通用机器翻译/未加约束的 LLM 经常把游戏黑话按字面翻译错(比如 FPS 语境下 "flank" 该译成"迂回/绕后",直译成"侧翼"就是错的)。多语言互译不能用语言两两之间的映射表维护(语言一多维护成本 N×(N-1) 增长),也不能把完整词典塞进每次翻译请求的 prompt(词典大了 token 成本失控,且大部分内容跟当前这句话无关)。

### 方案:语言无关中心 ID + 本地检测注入 + `<keep>` 标签保护
借鉴本地化行业 TBX/TermBase 的思路:每个术语概念用一个语言无关的 `term_id` 维护,下面挂各语言译法,而不是维护语言两两之间的映射关系。实现见 `src/domain/terminology.js`;词典数据一个游戏一个文件,`src/domain/terminology/<game_id>.json`,文件名本身就是 game_id,词条内部不用重复标游戏(见下面「游戏选择」一节)。

处理流程(插在 STT 转写完成之后、送 LLM 翻译之前):
1. 本地按"这段话的源语言"扫描词典命中——词典规模小(几十条量级)用"按长度降序排列的正则 alternation + 全局 `exec`"就等价于 Aho-Corasick 的效果,不需要引入专门的库;词典涨到几百上千条、实测这个方案变慢了,再考虑换专门库
2. 命中的词本地查表换成**目标语言的真实译词**(不是抽象占位符如 `{TERM_1}`)——LLM 面对纯符号缺少语义/语法线索,尤其法语这类有阴阳性、搭配讲究的语言,给它真实词汇才能让它借助自己的语言学知识把周围语法配对,用 `<keep>...</keep>` 把这个真实译词包起来
3. `<keep>` 标签相关指令只在这段话真的有命中时才动态加进 prompt(`buildTranslationMessages` 内部按 `text.includes('<keep>')` 判断),没命中的句子和没有这个功能之前的 prompt 完全一样,不多耗 token、不多引入一条可能被模型误读的规则
4. LLM 只需要调整标签周围的语法,标签内容原样保留;清理阶段用简单字符串处理去掉 `<keep>` 标签本身即可,不需要再做一次"ID → 词"的查表

已经用真实翻译 API(`TRANSLATE_PROVIDER=deepseek`)验证过指令遵循度:中/英/法互译测试(含法语阴阳性冠词这个关键考验场景)标签保留率和标签周围语法调整都符合预期。

### 术语检测用哪种语言扫描
`session.sourceLang`/`session.targetLang` 现在有系统默认值(源=zh、目标=en,见 `session.js`),用 `/lang source:<语言> target:<语言>` 改(两个参数都可选,只传一个就只改那个,另一个不动;两个都不传就回显当前设置)。目前 `/lang` 的 `addChoices` 只列了 zh/en 两个选项,不再提供"自动检测"。

`pipeline.js` 里 `resolveSpeakerLang` 还留着"用说话人第一段话的 STT 识别结果锁定语种"这条逻辑(跟 `assignSpeakerVoice` 首次开口判性别→分配音色是同一个模式),但因为 `sourceLang` 现在总有默认值,这条分支目前实际上不会被触发,是刻意保留的死代码——以后如果 `/lang` 想重新开放"自动检测"选项,这层逻辑不用重新写,把命令层的选项加回来接上就行。

**注意**:`STT_PROVIDER=groq` 时 Whisper 返回的语种字段可能是英文全称(如 "english")而非 ISO 码,跟词典的语言 key 对不上,会导致术语检测静默失效(优雅降级——不报错,就是不生效)。当前实际配置的供应商是 Deepgram,已经处理好(显式传 `detect_language=true` 并提取 ISO 码),不受影响。

### 游戏选择:`/game`(子命令列表,不是字符串选项)
最初 POC 阶段"不做 `/game` 选择机制"这个决定后来改了——`/game` 的每个游戏是一个 `addSubcommand`(而不是一个带 `addChoices` 的字符串选项),打 `/game` 直接弹游戏名列表(`/game whiteout`),不需要先输一个选项名再选值(`/game game:whiteout`)。可选游戏列表维护在 `src/domain/games.js`,新增游戏在这里加一条、再建一个对应的 `src/domain/terminology/<game_id>.json` 词典文件就行;`games.js` 声明了某个 `game_id` 但对应词典文件不存在,`terminology.js` 启动时直接报错,不会静默运行。

`session.js` 记录当前 session 的 `game`(默认 `games.js` 第一项,`/game` 可以实时改),`terminology.js` 的自动机按"游戏 → 语言"两层分组编译(见 `buildAutomatons`),`applyTerminology` 传入的 `game` 决定读哪个游戏的词典文件来扫描——不会因为别的游戏词典里有同名词条就串场。

### 当前范围
- 目前只做"本地检测 + 预翻译替换 + 标签保护"这一段。**翻译后校验(检查 `<keep>` 标签是否被破坏/丢失、失败时降级为本地硬替换兜底)这一层暂不做**,等靠现在这套日志观察出 LLM 真实的失败模式之后再针对性补,不然就是在猜

### 词典数据来源建议(按权威性排序)
1. 游戏官方本地化文件(如果可获取)——官方审定过的标准答案,权威性最高
2. 游戏 Wiki / 电竞术语库——冷启动素材,快速铺开覆盖面
3. 实际使用中人工修正积累——产品使用中发现 LLM 翻错的黑话,人工修正后加入词典,是随使用持续增长、越用越准的资产,不是一次性建完的静态内容

### 当前目标游戏:寒霜启示录(Whiteout Survival)
末日冰河题材的策略/放置类手游(SLG:联盟、行军集结、基地建设玩法),**不是** FPS/MOBA。词典需要覆盖联盟、行军、资源产出、建筑、英雄技能这类 SLG 特有黑话,跟这个功能最初 POC 阶段随手整理的一批通用 FPS/MOBA 黑话是完全不同的两套词汇——`src/domain/terminology/whiteout.json` 目前是空数组,等针对这个游戏的词条整理好再填。

---

## Discord Bot 配置信息

- Bot 名称:`cicada`
- 状态:Developer Portal 中已设为 Public(公开),已通过验证;实际使用仍限于开发者自建的私人测试 Discord 服务器,尚未走应用商店/App Directory 上架流程
- 测试服务器:开发者自建的私人测试 Discord 服务器
- 权限需求(OAuth2 URL Generator 中勾选):
  - scope:`bot` + `applications.commands`(后者漏勾的话,`/join`/`/leave`/`/lang`/`/game` 这些斜杠命令邀请进服务器后不会生效)
  - bot 权限:查看频道、发送消息、连接语音、讲话、使用语音活动
- 如涉及消息内容解析,需在 Developer Portal 手动开启 "Message Content Intent"

---

## 目标用户与语言范围

面向全球用户(除中国大陆地区,因 Discord 在该地区不可用)。产品最终形态希望支持"每个用户各自选择目标语言,收听对应翻译"这种个性化体验,但这在 Discord 原生语音频道架构下无法直接实现(bot 只能向整个频道播放一路音频),需要 companion app 才能做到。
