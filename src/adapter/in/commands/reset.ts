import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { resetSessionSettings } from '../../../application/session.js';

export const data = new SlashCommandBuilder()
  .setName('reset')
  .setDescription('Clear source/target language and game selection for this session');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  // guildId 必然存在，见 game.js 同样的 ! 断言惯例。
  const ok = await resetSessionSettings(interaction.guildId!);
  if (!ok) {
    await interaction.reply({ content: "I haven't joined a voice channel yet — use /join first.", ephemeral: true });
    return;
  }

  await interaction.reply({
    content:
      'Settings cleared. Source and target language must both be set again with ' +
      '`/config source:<language> target:<language>` before I can translate.',
    ephemeral: true,
  });
}
