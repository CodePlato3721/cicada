import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { getVoiceConnection } from '@discordjs/voice';
import { playPcmInChannel } from '../../out/playback.js';
import { generateTestMelodyPcm } from '../../../domain/test-tone.js';
import { createLogger } from '../../out/logger.js';

const logger = createLogger('commands/test');

export const data = new SlashCommandBuilder()
  .setName('test')
  .setDescription('Play a test sound to verify the "play PCM to voice channel" step works on its own');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  // guildId 必然存在，见 game.js 同样的 ! 断言惯例。
  const connection = getVoiceConnection(interaction.guildId!);

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
    logger.error({ err }, 'Failed to play test sound');
    await interaction.followUp({ content: 'Playback failed. Check the console logs for details.', ephemeral: true });
  }
}
