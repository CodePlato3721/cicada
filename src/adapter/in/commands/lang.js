import { SlashCommandBuilder } from 'discord.js';
import { getSession, setSourceLang, setTargetLang } from '../../../application/session.js';
import { TTS_PROVIDER_BY_LANG } from '../../../application/ports/tts.js';
import { SUPPORTED_SOURCE_LANGS } from '../../../application/ports/stt.js';

// 这里统一用 'zh' 这个 ISO 码而不区分简繁——语音场景不需要在选语言的时候纠结简体/繁体，
// 后端术语库内部用繁体匹配（见 terminology.js 的 opencc 正规化）跟这里选什么字面值无关，
// 用户不用关心这层。
//
// source 和 target 的可选语言列表不对称，是 STT/TTS 两个环节依赖的能力不一样导致的：
// source 只依赖 STT（Deepgram Nova-3 语言覆盖很广，这里先按项目实际用得上的挑了四个）；
// target 同时依赖 LLM 翻译（几乎任何语言都行）和 TTS 播报（决定性瓶颈）——现在 TTS 是
// 多供应商路由（见 ports/tts.js 的 TTS_PROVIDER_BY_LANG：en/fr/ja/de/es 走 Deepgram，
// zh/ko/pt/ar 走 Azure），target 选项直接从这张表的 key 生成，不再是之前只有 Deepgram
// 单一供应商时被迫限制成"只有 zh/en 两个能出声音"那个阶段。这里显式列出人类可读的语言名
// （用来生成 addChoices 的 name），跟 TTS_PROVIDER_BY_LANG 是同一份语言范围，只是那边
// 关心的是"该用哪个供应商"，这边关心的是"选项菜单里叫什么名字"。
const LANG_DISPLAY_NAMES = {
  zh: 'Chinese (zh)',
  en: 'English (en)',
  ko: 'Korean (ko)',
  ar: 'Arabic (ar)',
  fr: 'French (fr)',
  ja: 'Japanese (ja)',
  de: 'German (de)',
  es: 'Spanish (es)',
  pt: 'Portuguese (pt)',
};

// 从 SUPPORTED_SOURCE_LANGS 生成，跟 pipeline.js 自动检测锁定时用的白名单是同一份——
// 手动能选的语言范围，跟自动检测允许锁定的语言范围必须一致，不然会出现"手动能选但
// 自动检测永远不会锁到"或者反过来的不一致，两处引用同一个数组从根上避免这个问题。
const SOURCE_LANG_CHOICES = SUPPORTED_SOURCE_LANGS.map((lang) => ({
  name: LANG_DISPLAY_NAMES[lang] ?? lang,
  value: lang,
}));

// 从 TTS_PROVIDER_BY_LANG 的 key 生成，保证 target 选项永远跟"这个语言实际有没有 TTS
// 供应商能播"这件事同步——以后加/删一个 TTS_PROVIDER_BY_LANG 条目，这里的选项自动跟着变，
// 不用两个地方分别改、改漏了导致选项和实际能力对不上。
const TARGET_LANG_CHOICES = Object.keys(TTS_PROVIDER_BY_LANG).map((lang) => ({
  name: LANG_DISPLAY_NAMES[lang] ?? lang,
  value: lang,
}));

export const data = new SlashCommandBuilder()
  .setName('lang')
  .setDescription('Set source/target language for translation (neither has a default; no options shows current)')
  .addStringOption((option) =>
    option
      .setName('source')
      .setDescription('Source language: the language the speaker uses')
      .setRequired(false)
      .addChoices(...SOURCE_LANG_CHOICES),
  )
  .addStringOption((option) =>
    option
      .setName('target')
      .setDescription('Target language: what to translate into (limited by TTS voice coverage)')
      .setRequired(false)
      .addChoices(...TARGET_LANG_CHOICES),
  );

export async function execute(interaction) {
  const source = interaction.options.getString('source');
  const target = interaction.options.getString('target');

  const session = getSession(interaction.guildId);
  if (!session) {
    await interaction.reply({ content: "I haven't joined a voice channel yet — use /join first.", ephemeral: true });
    return;
  }

  // 只改传了的那个，另一个不动——两个参数都没传的话（比如就想看看现在是什么设置）
  // 也不报错，下面统一回复当前生效的完整配置。
  if (source) setSourceLang(interaction.guildId, source);
  if (target) setTargetLang(interaction.guildId, target);

  await interaction.reply({
    content:
      `Current settings — source: ${session.sourceLang ?? '(not set — will auto-detect from the first thing said)'}, ` +
      `target: ${session.targetLang ?? '(not set — translation is paused until you set one)'}`,
    ephemeral: true,
  });
}
