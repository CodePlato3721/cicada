import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { getSession, setSourceLang, setTargetLang } from '../../../application/session.js';
import { SOURCE_LANG_CHOICES, TARGET_LANG_CHOICES } from './language-choices.js';

// 用来单独调整某一个语言、或者查看当前设置——两个参数都是可选的。第一次配置推荐用
// /config 一次性把 source/target/game 都设好（见 config.ts），/lang 留给配置好之后
// 只想改其中一个的场景。

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

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const source = interaction.options.getString('source');
  const target = interaction.options.getString('target');

  // guildId 必然存在，见 game.js 同样的 ! 断言惯例。
  const session = getSession(interaction.guildId!);
  if (!session) {
    await interaction.reply({ content: "I haven't joined a voice channel yet — use /join first.", ephemeral: true });
    return;
  }

  // 只改传了的那个，另一个不动——两个参数都没传的话（比如就想看看现在是什么设置）
  // 也不报错，下面统一回复当前生效的完整配置。
  if (source) setSourceLang(interaction.guildId!, source);
  if (target) setTargetLang(interaction.guildId!, target);

  // 源语言不再有自动检测兜底（STT 语种检测实测准确度太低，已移除，见 pipeline.js）——
  // 跟 target 一样，不设置就是真的没设置，翻译会一直暂停，提示文案改成跟 target 对称。
  await interaction.reply({
    content:
      `Current settings — source: ${session.sourceLang ?? '(not set — translation is paused until you set one)'}, ` +
      `target: ${session.targetLang ?? '(not set — translation is paused until you set one)'}. ` +
      'Tip: `/config source:<language> target:<language> game:<game>` sets everything at once.',
    ephemeral: true,
  });
}
