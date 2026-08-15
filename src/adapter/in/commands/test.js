import { SlashCommandBuilder } from 'discord.js';
import { getVoiceConnection } from '@discordjs/voice';
import { playPcmInChannel } from '../../out/playback.js';
import { generateTestMelodyPcm } from '../../../domain/test-tone.js';

export const data = new SlashCommandBuilder()
  .setName('test')
  .setDescription('Play a test sound to verify the "play PCM to voice channel" step works on its own');

export async function execute(interaction) {
  const connection = getVoiceConnection(interaction.guildId);

  if (!connection) {
    await interaction.reply({ content: "I haven't joined a voice channel yet — use /join first.", ephemeral: true });
    return;
  }

  await interaction.reply({ content: 'Playing test sound (three notes, 2 seconds)...', ephemeral: true });

  const pcm = generateTestMelodyPcm();

  try {
    await playPcmInChannel(connection, pcm);
    await interaction.followUp({
      content: "Playback finished with no errors. If you didn't hear anything, the playback pipeline itself has an issue — check the [playback] console logs.",
      ephemeral: true,
    });
  } catch (err) {
    console.error('播放测试音效失败：', err);
    await interaction.followUp({ content: 'Playback failed. Check the console logs for details.', ephemeral: true });
  }
}
