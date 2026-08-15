import { SlashCommandBuilder } from 'discord.js';
import { resetSessionSettings } from '../../../application/session.js';

export const data = new SlashCommandBuilder()
  .setName('reset')
  .setDescription('Clear source/target language and game selection for this session');

export async function execute(interaction) {
  const ok = resetSessionSettings(interaction.guildId);
  if (!ok) {
    await interaction.reply({ content: "I haven't joined a voice channel yet — use /join first.", ephemeral: true });
    return;
  }

  await interaction.reply({
    content:
      'Settings cleared. Source language will auto-detect again from the next thing said; ' +
      'target language must be set again with `/lang target:<language>` before I can translate.',
    ephemeral: true,
  });
}
