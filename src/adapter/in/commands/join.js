import { SlashCommandBuilder } from 'discord.js';
import { joinVoiceChannel, entersState, VoiceConnectionStatus } from '@discordjs/voice';
import { startListening } from '../voice-listener.js';

export const data = new SlashCommandBuilder()
  .setName('join')
  .setDescription('Join your current voice channel and start real-time listening + translation');

export async function execute(interaction) {
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
    startListening(connection, voiceChannel);
    await interaction.editReply(
      `Joined voice channel: ${voiceChannel.name}. Now listening automatically. ` +
        'Before I can translate anything, you must set a target language with `/lang target:<The language you want Cicada to speak>` — ' +
        "until you do, I'll just remind you to set it instead of translating. " +
        "Source language is optional — if you don't set it with `/lang source:<language>`, I'll auto-detect it from the first thing said and lock it in (I'll post a message here once that happens). Use /leave to stop.",
    );
  } catch (err) {
    console.error('加入语音频道失败：', err);
    await interaction.editReply('Failed to join the voice channel. Check the console logs for details.');
  }
}
