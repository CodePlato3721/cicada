# Discord App Description

Discord Developer Portal 上应用的"概况"(App Directory / 应用描述)页面文案。这个页面本身不在代码仓库里管理(在 Discord 后台手动编辑),这份文件是它的备份/维护副本——改了这边记得同步过去 Developer Portal,反之亦然。

面向的是**最终用户**(Discord 应用商店/服务器邀请页面看到这段文字的人),不是开发者,所以是英文、产品向的语气,跟 [README.md](../README.md)(中文、开发者向,讲怎么跑起来)、[CLAUDE.md](../CLAUDE.md)(中文、架构决策记录)不是一回事,不要混着改。

最近一次更新:2026-08-14,同步了「语音回复语言」(Azure TTS 接入后从 2 种扩到 9 种)和 `/reset` 命令。

---

**WHAT IS CICADA?**

Cicada is a real-time voice translation bot for Discord. It listens to a game voice channel, detects when someone finishes speaking, transcribes and translates their speech, and speaks the translation back into the channel — so squadmates who don't share a language can still coordinate in real time.

**HOW IT WORKS**

1. `/join` — Cicada joins your voice channel and starts listening to everyone
2. As each person speaks, their sentence is transcribed, translated, and spoken back automatically
3. `/leave` — Cicada stops listening and leaves

**COMMANDS**

- `/join` — start listening in your current voice channel
- `/leave` — stop and disconnect
- `/lang source:<lang> target:<lang>` — set source/target language
- `/game whiteout` — select the game context for terminology handling
- `/reset` — clear source/target language and game selection for this session
- `/test` — play a short test sound in the voice channel to verify playback is working

**CURRENT STATUS: BETA**

- **Supported game:** Whiteout Survival (game-specific terminology handling)
- **Languages:** Understands Chinese, English, Korean, and Arabic speech. Replies are translated and spoken back in 9 languages — Chinese, English, Korean, Arabic, French, Japanese, German, Spanish, and Portuguese.
- More games and languages are planned as the bot matures.

**BETA & FEEDBACK**

Cicada is currently in beta. Found a bug or have a feature request? Join our support server: Cicada Support Server
