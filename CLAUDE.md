# cicada 项目 Context

## 项目定位

专注游戏领域的实时语音翻译 App,核心场景是 Discord 语音频道里的跨语言玩家组队/开黑沟通。核心链路:`/join` 后自动监听频道内所有人的语音,本地 Silero VAD 实时切句 → Deepgram STT → LLM 翻译(Groq/DeepSeek,见「供应商可切换」)→ TTS 按目标语言路由到 Deepgram 或 Azure Speech 播回频道;`/leave` 停止监听并退出。

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
STT/翻译两个环节各自通过端口(`src/application/ports/`)与具体供应商解耦,由 `STT_PROVIDER`/`TRANSLATE_PROVIDER` 环境变量选择实现,换供应商不用改业务代码。当前:
- STT:Deepgram(`nova-3`)
- 翻译:Groq(`llama-3.1-8b-instant`),备用 DeepSeek

**TTS 不是这个模式**——不是"进程启动时选一个供应商用到底",是**按目标语言动态路由到不同供应商**,因为没有一个供应商能覆盖这个项目要的全部目标语言:
- 当前供应商:Deepgram(Aura-2,覆盖 en/fr/ja/de/es)+ Azure Speech(覆盖 zh/ko/pt/ar)
- 路由表是 `src/application/ports/tts.js` 的 `TTS_PROVIDER_BY_LANG`(目标语言 → 供应商名),不是环境变量——不存在 `TTS_PROVIDER` 这个配置项。想调整某个语言用哪个供应商,改这张表,不是改 `.env`。没有做"这张表跟各供应商 adapter 自己声明的 `TTS_SUPPORTED_LANGS` 是否一致"这层启动期校验——`TTS_SUPPORTED_LANGS` 跟实际接的音色列表在同一个小文件里,改音色时顺手就会改这个数组,两者对不上的概率低,不值得加这层防御
- `session.ttsProvider` 字段跟 `session.targetLang` 联动(`session.js` 的 `setTargetLang` 里一起设置),目标语言不在 `TTS_PROVIDER_BY_LANG` 里就是 `undefined`——`pipeline.js` 靠这个判断"这个目标语言没法出声音,只有译文文字",不是判断"当前唯一供应商的 `TTS_SUPPORTED_LANGS`"(那是单供应商时代的旧逻辑,已经不适用)
- 中文用繁体音色(Deepgram STT 那边 zh→zh-TW 是同一个理由:项目排除中国大陆用户、以繁体中文使用者为主);阿拉伯语用沙特阿拉伯(ar-SA)音色,Azure 没有跟 STT 那边裸 `ar` 代码对应的"通用阿拉伯语"选项;葡萄牙语用巴西口音(pt-BR),全球使用人口远多于葡萄牙本土
- 说话人的 TTS 音色按"供应商+语言"分开存(`speakerState.voicesByProviderLang`,`"provider:lang" -> voice`),不是单个 `.voice` 字段、也不能只按供应商存——**实测踩过的真实 bug**:每个 adapter 的音色池最初是按"供应商 → 性别"两层分组(比如 Azure 一个 `male` 数组里混着 zh/ko/pt/ar 四种语言的音色),`assignVoice` 按性别随机挑的时候完全不知道要念哪种语言,出现过目标语言是中文却随机分配到 `pt-BR-AntonioNeural`(葡萄牙语)去念中文文本,Azure 只能返回一份没有实际内容的空音频(44 字节,标准"空音频"WAV 的大小),下游 `wav.js` 解析直接报错(`channels=0, sampleRate=0, bitsPerSample=0`)。修复:音色池改成按"**语言 → 性别**"两层分组(`VOICES_BY_LANG_AND_GENDER`,每个 adapter 都有),`assignVoice`/`getVoicesByGender` 都要求显式传 `lang`;缓存 key 同理必须是"供应商+语言"组合,不能只按供应商——同一个供应商可能覆盖好几种语言(比如 deepgram 覆盖 en/fr/ja/de/es),只按供应商缓存会导致同一个人从 `target:en` 切到 `target:fr`(供应商都是 deepgram,没变)时错误复用缓存的英语音色去读法语文本。目标语言变化导致供应商或语言组合切换时会给新组合单独分配一个音色,不保证跟旧组合听感一致,这是多供应商架构没法避免的取舍
- `/lang target:` 的可选语言列表从 `TTS_PROVIDER_BY_LANG` 的 key 动态生成(见 `lang.js`),不是手写的固定列表,加/删一个路由表条目,`/lang` 的选项自动跟着变

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
Deepgram Aura-2 / Azure Speech(语音合成,按目标语言路由,联网调用)
      │
      ▼
返回 Node.js 服务器 → 播放回 Discord 语音频道 / 或输出文字字幕
```

**当前供应商组合:STT 用 Deepgram,翻译设计上默认 Groq、备用 DeepSeek,TTS 按目标语言在 Deepgram/Azure 之间路由(见「供应商可切换」一节的 `TTS_PROVIDER_BY_LANG`)。** STT/TTS 最初也在 Groq(Whisper + Orpheus),后来切到 Deepgram(Nova-3 + Aura-2);翻译环节设计上留在 Groq,理由不变:Llama 3.1 8B Instant 价格($0.05/$0.08 每百万 token)低,且 Groq 的 TTFT 在多份第三方评测中排名第一梯队。**但 `.env` 里 `TRANSLATE_PROVIDER` 当前实际配置的是 `deepseek`**(不是 Groq)——开发过程中发现 Groq 免费额度的 RPM/TPM 限制(见下一节)在多人/多句并发场景下容易触顶,临时切到 DeepSeek 更稳定;`TRANSLATE_PROVIDER=groq` 仍然是完整实现、随时能切回去,只是当前实际跑的不是它,排查线上问题时不要想当然认为翻译走的是 Groq,以 `.env` 里的值和启动日志(`[ports/translate] 翻译供应商：...`)为准。

---

## 具体模型与定价参考(建议实际调用前在对应控制台核实最新价格)

| 环节 | 供应商/模型 | 价格 | 备注 |
|---|---|---|---|
| STT | Deepgram nova-3(Pre-Recorded) | 需在 console.deepgram.com 核实 | 项目用法是存好 wav 文件再转录,不是流式 |
| 翻译 | Groq llama-3.1-8b-instant | $0.05/M输入,$0.08/M输出 | 通用小模型;`TRANSLATE_PROVIDER=deepseek` 可切到 DeepSeek 备用 |
| TTS(en/fr/ja/de/es) | Deepgram Aura-2 | 需在 console.deepgram.com 核实 | `TTS_PROVIDER_BY_LANG` 路由到 deepgram 的语言 |
| TTS(zh/ko/pt/ar) | Azure Speech(Neural 音色) | 需在 Azure Portal 核实 | `TTS_PROVIDER_BY_LANG` 路由到 azure 的语言,中文用繁体(zh-TW) |

### 已解决:TTS 曾经只支持英语
早期 Deepgram Aura-2 只接入了英文音色,中文/韩文/阿拉伯语没法出声音。后来给 en/fr/ja/de/es 五个语言在 `deepgram/tts.js` 补上了对应音色,并新接入 Azure Speech TTS 覆盖 zh/ko/pt/ar,具体路由见「供应商可切换」一节。

---

## Groq 免费额度(翻译环节,注意分维度限制)

- 翻译 LLM:约 30 RPM(每分钟请求数)、6000 TPM(每分钟token数)、每天 1000-14400 次请求(不同来源数字有出入,以控制台实际显示为准)

**注意**:免费额度按维度限制,不是单一总量。VAD 切句过密可能优先触发 RPM/TPM 限制,而不是总请求数限制。单人测试通常够用,多人并发容易触顶。

超出免费额度可绑定信用卡升级 Developer tier,不产生额外费用直到实际用量超出,且解锁更高限额 + 约25%折扣。

STT/TTS 已切到 Deepgram,其额度/计费规则需登录 console.deepgram.com 核实,不再适用上面 Groq 的限制。

---

## 网络请求超时保护(`API_TIMEOUT_MS`)

### 问题
实测踩过坑:DeepSeek 有一次单次请求卡了 34 秒才返回,期间这句话的整条流水线悄悄挂在后台,用户完全感知不到,等它终于返回时会跟后面已经处理完的句子一起爆发式播出来。原生 `fetch` 不带超时,慢请求会无限拖着不失败、不重试。

### 方案
- `src/adapter/out/http.js` 的 `fetchWithTimeout` 给所有手写 `fetch` 调用(Deepgram STT+TTS、Azure TTS、DeepSeek 翻译)统一包一层 `AbortController`,超过 `API_TIMEOUT_MS`(默认 **5000**,2026-08-14 从 15000 下调)没响应就直接 abort 抛错,**不重试**
- Groq 走官方 SDK,不经过 `fetchWithTimeout`,而是在 `groq/client.js` 里显式配置 `timeout: API_TIMEOUT_MS`(同一个环境变量,保持跟其他供应商同一个量级)、`maxRetries: 1`(SDK 默认是 1 分钟超时 + 重试 2 次,对实时语音链路太宽松,降到"超时更短、只重试一次",最坏情况也只是当前超时值的 2 倍,不会拖出离谱的等待)
- 这个超时只保护"单次网络请求"不无限挂起,不代表 `handleSegment` 整个函数有个总的超时上限——一句话要经过 STT/翻译/TTS 三次独立请求,每次各自最多等 `API_TIMEOUT_MS`(Groq 场景下翻译这一步最多 2 倍),叠加起来才是这句话失败前最坏能拖多久
- 调这个值是全局的(影响 STT/翻译/TTS 三个环节的所有供应商),不是分环节各自配置

---

## VAD 切句注意事项

- VAD 本身运算量极小(毫秒级,CPU 可跑),延迟主要来自"等待静音间隔"这个机制本身,不是算法慢
- 静音判定阈值需要作为可调参数设计,不要硬编码:
  - 阈值过短 → 容易把自然停顿误判为句子结束,翻译支离破碎
  - 阈值过长 → 延迟增加
- 切句粒度直接影响 STT 调用成本(切太碎请求数暴涨),需要平衡"响应速度"与"成本效率"

---

## 播放顺序保证(sequence 号 + 播放队列重排)

### 问题
每句话的 STT/翻译/TTS 是"发射后不管"并发跑的(`pipeline.js` 顶部注释),不会等上一句处理完再处理下一句。这意味着后说的话如果翻译得快,可能比先说的话(翻译慢)先跑到播放这一步——实测复现过:先说的句子因为翻译 API 响应慢了几秒,比后说的句子晚返回,结果播放顺序变成"后说的先播、先说的后播"。

### 方案
- `session.js` 维护每个 guild 一个严格递增计数器 `playbackSeq`,`nextPlaybackSequence(guildId)` 分配下一个号
- 号码必须在 `voice-listener.js` 的 `handleDetectedSegment` 里、VAD 刚判定"这句话说完了"的那一刻**同步**分配,再传给 `handleSegment`——不能等 `handleSegment` 异步处理完再分配,那样分配到的是"处理完的顺序"而不是"说话的顺序",起不到重排作用
- `playback-queue.js` 不再是纯 FIFO,而是按 sequence 做重排缓冲区(`pending: Map<sequence, pcmBuffer|null>`):必须先播完 sequence 小的,sequence 大的就算先到也要等着
- `pipeline.js` 的 `handleSegment` 用 `try/finally` 包住整个函数体:凡是提前 `return` 的分支(目标语言未设置、源语言检测失败、翻译结果为空、目标语言没有 TTS 供应商等)都不会真正播放东西,但这个 sequence 号已经分配出去了,必须显式调用 `skipPlaybackSequence(guildId, sequence)` 告诉播放队列"这个号位跳过、不用等",不然重排缓冲区会一直卡在等一个永远不会到来的号码,后面所有已经处理完的句子全部播不出来。`finally` 块统一处理(`if (!enqueued) skipPlaybackSequence(...)`),不用在每个 `return` 语句那里手动加一遍

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
`session.sourceLang`/`session.targetLang` **现在都没有默认值**(见 `session.js` 的 `createSession`)——`/join` 之后两个都是 `undefined`,行为不对称:

- **`targetLang`**:必须显式 `/lang target:<语言>` 设置一次才能开始翻译,没有任何兜底。`/join` 成功后的回复文字会明确提示这一点。设置之前,`pipeline.js` 的 `handleSegment` 检测到 `session.targetLang` 是假值,**跳过 STT/翻译**(不浪费 API 额度),改为往 `session.voiceChannel` 发一条**固定文字提示**("⚠️ I can't translate yet — set a target language first with `/lang target:<language>`")。这条提示**故意不走语音播报**——最初的实现是合成播报语音,实测遇到过"日志显示播放成功、实际频道里完全没声音"这种静默失败(Discord 连接层面的权限/静音问题,bot 自己感知不到),排查成本高;文字消息走 `voiceChannel.send`,链路短得多,不依赖 TTS 供应商这条链路,失败了控制台也有明确报错,不会静默。这个提示**没有做节流/去重**,每次有人说话且 target 还没设置就会发一次,连续说话会连续触发、在频道文字聊天里堆好几条重复消息——刻意先做最简单的版本,如果实测太吵再加节流。
- **`sourceLang`**:`/lang source:<语言>` 手动设置优先;没手动设置的话,**第一句话会让 STT 自动检测**(`transcribe` 不传 `language` 参数,Deepgram 走 `detect_language=true`),检测结果通过 `setSourceLang` 写回 `session.sourceLang`——是 **session(guild)级别的锁定,不是按说话人各自锁定**,之后同一场会话所有人共用这个源语言,不会每句话都重新检测。锁定的同时会往 `session.voiceChannel`(bot 加入的那个语音频道自带的文字聊天)发一条通知,告知用户自动检测并设置成了什么语言,并问一句"检测得对不对,不对就手动 `/lang source:<语言>`"。
  - **检测结果要先过白名单**(`ports/stt.js` 的 `SUPPORTED_SOURCE_LANGS = ['zh','en','ko','ar']`,跟 `/lang source:` 手动能选的范围是同一个数组,`lang.js` 的 `SOURCE_LANG_CHOICES` 直接从这里派生,不会出现两边不一致):实测极短音频容易检测出离谱结果(0.86 秒的"hello hello"被判成 `cs` 捷克语;说印尼语"Halo halo"被判成 `id`,这个本身没判错但项目没打算支持)。检测结果不在白名单里就**不锁定**——锁进去的话之后整场会话都会用错误语言偏置 STT,把后续所有语音识别成乱码,比"没能自动锁定"严重得多
  - **检测结果不在白名单里,也要往语音频道发文字通知**("检测失败,请手动设置"),不能什么都不做——最早的版本是纯打日志、不通知用户,会出现"一直卡着不锁定、用户完全不知道发生了什么"这种体验落差,所以两种情况(检测成功/检测到不支持的语言)都会发通知,只是内容不同
  - **检测失败发完通知要 `return`,不能继续往下走**——中间版本加了通知但漏了这一步,导致刚提示完用户"没检测出你的语言,请手动设置",紧接着还是拿这句话(语言都没确认)去翻译、播报,逻辑前后矛盾。现在检测到不支持的语言时,发完通知直接 `return`,这句话不翻译、不播报;只有真的锁定成功(检测到白名单内的语言)才会继续往下走完整条流水线

两个都是刻意的产品决定,不是疏漏:早期版本两者都有默认值(源=zh、目标=en 或读 `.env` 的 `SOURCE_LANG`/`TRANSLATE_TARGET_LANG`),但这样会悄悄把语言定成一个用户可能压根没注意到、也不是他们想要的选项。现在改成"target 强制显式设置,source 退而求其次靠自动检测兜底"。

**`pipeline.js` 往语音频道发文字消息的机制**:这是项目里第一次真正实现"bot 发文字消息"(之前只有 slash 命令的 `interaction.reply`,`pipeline.js` 完全没有对外通信能力)。做法是 `join.js` 把 `voiceChannel`(discord.js 的语音频道对象,同时也是合法的文字发送目标——Discord 的语音频道自带文字聊天)一路传给 `startListening` → `createSession`,存进 `session.voiceChannel`;`pipeline.js` 需要通知用户时直接 `session.voiceChannel?.send(...)`,失败了 `.catch()` 打日志、不让通知失败拖垮整个 pipeline。

`/lang` 的 `source`/`target` 的**可选语言列表**(不是默认值,是 `/lang` 命令里能选哪些语言)本身是**两份不同的 `addChoices` 列表**,不对称,是 STT/TTS 依赖的能力不一样导致的:
- `source`(源语言,只依赖 STT):zh/en/ko/ar 四个,Deepgram STT(Nova-3)这四种都支持,是手动挑的、不是 Nova-3 能力上限(Nova-3 实际支持 60+ 种语言,项目目前只用得上这四个)
- `target`(目标语言,同时依赖 LLM 翻译和 TTS 播报):**现在覆盖 9 种**(zh/en/ko/ar/fr/ja/de/es/pt),从 `ports/tts.js` 的 `TTS_PROVIDER_BY_LANG` 的 key 动态生成(见 `lang.js`)——这是接入 Azure TTS(见上面"供应商可切换"那节)之后才做到的,早期只有 Deepgram 一个 TTS 供应商时,target 被迫只能开放 zh/en 两个(Deepgram Aura-2 当时只接了英文音色),选了别的语言翻译文字能正常生成但播报会被静默跳过。现在 target 选项数量直接绑定 `TTS_PROVIDER_BY_LANG` 有多少条,不会再出现"选项里能选、但其实播不出声音"这种不一致。

**已知的语言无关性 bug 修复**:`terminology.js` 里判断"要不要给正则加 `\b` 词边界"的集合,原来叫 `CJK_LANGS`,只列了 zh/ja/ko——但真正的判断依据是"这门语言的文字在不在 JS 正则 `\w`(只认 ASCII 拉丁字母/数字/下划线)覆盖范围内",不是"是否空格分词"。阿拉伯语虽然是空格分词,但阿拉伯文字符同样不在 `\w` 里,加了 `\b` 一样会匹配不到——这两件事只是在中日韩身上恰好同时成立,不能当成通用判断标准。已改名 `NO_WORD_BOUNDARY_LANGS` 并加入 `'ar'`,以后再加不用 `\w` 覆盖的文字系统语言,照这个真正的判断依据加,不要照搬"是否空格分词"这条错误的心智模型。

**历史备注(已解决,留着说明这段决策过程)**:上面提到的"target 只能开放 zh/en"这个限制后来通过接入 Azure Speech TTS 解决了(见"供应商可切换"一节)。项目里还留着切到 Deepgram 之前的旧 TTS adapter(`src/adapter/out/groq/tts.js`,Orpheus 模型,`TTS_SUPPORTED_LANGS = ['en', 'ar']`),但 `TTS_PROVIDER_BY_LANG` 现在没有任何语言路由到它,是没被使用的遗留代码,不是活跃供应商——真正接入并路由到 `ar`/`zh`/`ko`/`pt` 的是 Azure。

**注意**:`STT_PROVIDER=groq` 时 Whisper 返回的语种字段可能是英文全称(如 "english")而非 ISO 码,跟词典的语言 key 对不上,会导致术语检测静默失效(优雅降级——不报错,就是不生效)。当前实际配置的供应商是 Deepgram,已经处理好(显式传 `detect_language=true` 并提取 ISO 码),不受影响——这一点现在也直接关系到 `sourceLang` 自动检测锁定这条新逻辑,`session.sourceLang` 写入的值就是这个 `detected_language`,如果哪天切回 Groq STT 又没处理好这个映射,自动检测锁定的值会是不对的英文全称。

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
  - scope:`bot` + `applications.commands`(后者漏勾的话,`/join`/`/leave`/`/lang`/`/game`/`/reset` 这些斜杠命令邀请进服务器后不会生效)
  - bot 权限:查看频道、发送消息、连接语音、讲话、使用语音活动
- 如涉及消息内容解析,需在 Developer Portal 手动开启 "Message Content Intent"

---

## 目标用户与语言范围

面向全球用户(除中国大陆地区,因 Discord 在该地区不可用)。产品最终形态希望支持"每个用户各自选择目标语言,收听对应翻译"这种个性化体验,但这在 Discord 原生语音频道架构下无法直接实现(bot 只能向整个频道播放一路音频),需要 companion app 才能做到。

---

## 部署环境与当前进度(截至 2026-08-14)

### 生产服务器规格——很小,是排查性能问题时的关键背景
DigitalOcean 最小档 Droplet:**1 vCPU / 1GB 内存 / 2GB swap**(主机名 `ubuntu-s-1vcpu-1gb-nyc2`),`pm2` 管理进程(`pm2 logs cicada`/`pm2 monit`/`pm2 describe cicada`)。这台机器目前只是开发/测试用途,不代表将来上量后的生产规格——排查"是不是并发/资源撑不住"这类问题时,结论要限定在"这台机器上"成立,不能直接套用到"将来几百上千个 guild 会不会也这样"(那是完全不同量级的横向扩展问题,不是这台单机能不能扛的问题)。

### 已确认但还没修的架构缺口:没有并发上限
`pipeline.js` 的 `handleSegment` 是"发射后不管"并发跑的(见「播放顺序保证」一节),**目前没有任何并发限流**(没有 semaphore/p-limit 之类的东西)。VAD 把一个人连续说的好几句话切成多个 segment 时,每个 segment 都会同时发起独立的 STT/翻译/TTS 请求。在上面这台 1vCPU/1GB 的小机器上,实测出现过单句处理时间被拖到 **200~400 秒**量级(正常应该是几秒)的情况——怀疑是内存/CPU 争抢导致(见下面的实测证据),不是外部供应商限流(已排除:那次实际配置的翻译供应商是 DeepSeek,不是有 30 RPM 免费额度限制的 Groq,五到二十个并发请求撞不到 DeepSeek 这种通用 API 的限流)。**这个并发上限目前是刻意还没加的**——本次排查过程中用户明确要求"先别改代码,只分析 root cause",还没进入实施阶段,下一步可以做的方向:给 `handleSegment` 的并发数量加个上限(比如 p-limit),或者至少给单个说话人的连续 segment 加个节流。

### 2026-08-13/14 实测证据(一次真实的用户测试 session,供下次排查参考)
- 服务器 `dmesg` 里能查到一次真实的 OOM(内存耗尽)内核强杀事件:`[Thu Aug 13 18:11:05 2026] Out of memory: Killed process 8894 (MainThread) ... anon-rss:552816kB`。**注意:还没确认这个被杀的 `MainThread` 进程就是 cicada**(进程名不像典型的 Node 进程名,更像 Python 的默认主线程名;而且这个时间点跟下面那次卡顿事故的时间对不上,是两码事)——下次排查可以拿这个时间戳去 `grep "2026-08-13T18:1" /root/.pm2/pm2.log` 或 `journalctl --since "2026-08-13 18:08:00" --until "2026-08-13 18:14:00"` 找有没有 cicada 意外退出/重启的记录来实锤
- 同一次测试里还发现一个**独立的、真实存在的播放 bug**(不是上面并发问题的直接后果,是它的连锁反应):某句话处理了 396302ms(约 6.6 分钟)才终于 TTS 合成完,轮到播放时日志显示 `[playback] connection.subscribe 结果: 失败（返回了 undefined）`,播放器立刻进入 `autopaused` 状态——怀疑是处理耗时太久期间 Discord 语音连接的心跳被延误、连接已经不是 Ready 状态,`connection.subscribe()` 在这种情况下会返回 `undefined`(`@discordjs/voice` 的既有行为)。这个 bug**还没修**,目前没有针对"连接可能已经失效"做检测或重连;根源还是上面那条"没有并发上限导致单句处理时间失控"——先把并发限流加上,这个连锁反应大概率会自然消失,但即便如此,"连接失效时应该怎么处理"这个问题本身也值得单独看一下(比如播放前检查 `connection.state.status`,不是 Ready 就跳过或触发重连)
- 同一次测试里还有一批句子翻译成功(`译文(zh): "..."` 有打印)但完全没有对应的 `-tts.wav` 文件、日志里也没看到后续任何输出——**原因还没确认**,怀疑是命中了 `!provider` 静默 return 分支(比如当时部署在服务器上的代码版本比本地仓库旧,可能还没接入 Azure TTS、`zh` 还没路由到任何供应商),也可能是 `synthesize()` 抛错但错误日志没贴全。下次排查先确认服务器上部署的代码版本(`git log -1` 或直接比对文件内容)是不是已经包含 Azure TTS 路由

### 今天(2026-08-14)完成并已推送到 `origin/main` 的修复,但还没部署到服务器
以下 5 个 commit 已经推到 `main`,但上面这次测试用的服务器代码是这些修复**之前**的旧版本(那台服务器还没重新拉取/重启),上面记录的所有实测证据都是旧代码的行为,不代表这些问题在新代码里依然存在:
1. TTS 音色语言错配 bug 修复 + Azure Speech 接入
2. 语言系统重设计(target 强制显式设置、source 自动检测+白名单锁定)+ `/reset` 命令
3. `/join` 自动放测试音效 + 回复拆成两条消息
4. **播放顺序保证**(sequence 号 + 播放队列重排,见「播放顺序保证」一节)+ `API_TIMEOUT_MS` 默认从 15000 降到 5000
5. 文档同步

**下一步(还没做,留给下次继续)**:
- 把最新代码部署到服务器(`git pull` + `pm2 restart cicada`,或者用户平时的部署流程)
- 部署后重新用同样的"连续说好几句话"场景复测,确认 `API_TIMEOUT_MS=5000` + 播放顺序修复之后,单句处理时间和播放顺序是否恢复正常
- 视复测结果决定要不要实施并发上限(如果新代码 + 更短超时之后问题基本消失,可能暂时不急;如果多人同时说话还是会顶到瓶颈,再加限流)
- 确认那次 OOM 事件里被杀的 `MainThread` 进程到底是不是 cicada(见上面「实测证据」的排查命令)
- 排查"翻译成功但 TTS 完全没生成"这批句子的具体原因(确认服务器部署的代码版本、检查完整日志里有没有被截断的错误信息)
