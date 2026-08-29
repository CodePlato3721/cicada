import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { joinVoiceChannel, entersState, VoiceConnectionStatus } from '@discordjs/voice';
import { startListening } from '../voice-listener.js';
import { playPcmInChannel } from '../../out/playback.js';
import { generateTestMelodyPcm } from '../../../domain/test-tone.js';
import { createLogger } from '../../out/logger.js';

const logger = createLogger('commands/join');

export const data = new SlashCommandBuilder()
  .setName('join')
  .setDescription('Join your current voice channel and start real-time listening + translation');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: "You need to join a voice channel first so I can follow you in.", ephemeral: true });
    return;
  }

  const voiceChannel = interaction.member?.voice?.channel;

  if (!voiceChannel) {
    await interaction.reply({ content: "You need to join a voice channel first so I can follow you in.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
    await startListening(connection, voiceChannel);

    await interaction.editReply(
      `Joined voice channel: ${voiceChannel.name}. Now listening automatically.\n\n` +
        "Playing a quick test sound now — can you hear it? If not, click the three dots to the left of the hang-up button " +
        'in the voice control bar below, choose **Voice & Video Settings**, and check your output/speaker device. ' +
        'Then run `/test` again until you can hear it.',
    );

    try {
      await playPcmInChannel(connection, generateTestMelodyPcm());
    } catch (err) {
      logger.error({ err }, 'Failed to play self-check sound after /join');
    }

    await interaction.followUp({
      content:
        'Before I can translate anything, you must configure me with ' +
        '`/config source:<language they speak> target:<language you want Cicada to speak> game:<optional>` — ' +
        "until you do, I'll just remind you to set it instead of translating.\n\n" +
        'Use /leave to stop.',
      ephemeral: true,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to join the voice channel');
    await interaction.editReply('Failed to join the voice channel. Check the console logs for details.');
  }
}
