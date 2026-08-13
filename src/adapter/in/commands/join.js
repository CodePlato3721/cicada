import { SlashCommandBuilder } from 'discord.js';
import { joinVoiceChannel, entersState, VoiceConnectionStatus } from '@discordjs/voice';
import { startListening } from '../voice-listener.js';

export const data = new SlashCommandBuilder()
  .setName('join')
  .setDescription('加入你当前所在的语音频道，并自动开始实时监听+翻译（不用再 /record）');

export async function execute(interaction) {
  const voiceChannel = interaction.member?.voice?.channel;

  if (!voiceChannel) {
    await interaction.reply({ content: '你需要先加入一个语音频道，我才能跟过去。', ephemeral: true });
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
    startListening(connection);
    await interaction.editReply(
      `已加入语音频道：${voiceChannel.name}，开始自动监听——频道里任何人说话都会被实时切句、翻译、念出来。/leave 退出。`,
    );
  } catch (err) {
    console.error('加入语音频道失败：', err);
    await interaction.editReply('加入语音频道失败，详情看控制台日志。');
  }
}
