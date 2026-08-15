import { SlashCommandBuilder } from 'discord.js';
import { joinVoiceChannel, entersState, VoiceConnectionStatus } from '@discordjs/voice';
import { startListening } from '../voice-listener.js';
import { playPcmInChannel } from '../../out/playback.js';
import { generateTestMelodyPcm } from '../../../domain/test-tone.js';

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

    // 第一条消息：确认加入 + 马上要放一段自检音效，让用户提前知道接下来会发生什么。
    // 内容跟 /test 命令播放的是同一段三音符旋律（domain/test-tone.js 共用），
    // 目的一样——排除"整条语音链路(bot 权限/静音/Discord 输出设备)本身有没有问题"
    // 这个变量，不用等真的翻译失败了才去猜是不是播放这一层出的问题。
    await interaction.editReply(
      `Joined voice channel: ${voiceChannel.name}. Now listening automatically.\n\n` +
        "Playing a quick test sound now — can you hear it? If not, click the three dots to the left of the hang-up button " +
        'in the voice control bar below, choose **Voice & Video Settings**, and check your output/speaker device. ' +
        'Then run `/test` again until you can hear it.',
    );

    try {
      await playPcmInChannel(connection, generateTestMelodyPcm());
    } catch (err) {
      console.error('[join] /join 后自检音效播放失败：', err);
    }

    // 第二条消息：语言设置说明 + /leave，跟第一条的"能不能听到声音"这个自检关注点
    // 不是一回事，拆开发，避免堆成一大段。
    await interaction.followUp({
      content:
        'Before I can translate anything, you must set a target language with `/lang target:<The language you want Cicada to speak>` — ' +
        "until you do, I'll just remind you to set it instead of translating.\n\n" +
        "Source language is optional — if you don't set it with `/lang source:<language>`, I'll auto-detect it from the first thing said and lock it in.\n\n" +
        'Use /leave to stop.',
      ephemeral: true,
    });
  } catch (err) {
    console.error('加入语音频道失败：', err);
    await interaction.editReply('Failed to join the voice channel. Check the console logs for details.');
  }
}
