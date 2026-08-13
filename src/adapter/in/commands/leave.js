import { SlashCommandBuilder } from 'discord.js';
import { getVoiceConnection } from '@discordjs/voice';
import { stopListening } from '../voice-listener.js';

export const data = new SlashCommandBuilder()
  .setName('leave')
  .setDescription('停止监听并离开当前语音频道');

export async function execute(interaction) {
  const connection = getVoiceConnection(interaction.guildId);

  if (!connection) {
    await interaction.reply({ content: '我现在不在任何语音频道里。', ephemeral: true });
    return;
  }

  stopListening(interaction.guildId);
  connection.destroy();
  await interaction.reply({ content: '已停止监听，离开语音频道。', ephemeral: true });
}
