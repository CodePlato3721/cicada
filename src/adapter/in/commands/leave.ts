import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { getVoiceConnection } from '@discordjs/voice';
import { stopListening } from '../voice-listener.js';

export const data = new SlashCommandBuilder()
  .setName('leave')
  .setDescription('Stop listening and leave the current voice channel');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const connection = getVoiceConnection(interaction.guildId!);

  if (!connection) {
    await interaction.reply({ content: "I'm not in any voice channel right now.", ephemeral: true });
    return;
  }

  await stopListening(interaction.guildId!);
  connection.destroy();
  await interaction.reply({ content: 'Stopped listening and left the voice channel.', ephemeral: true });
}
