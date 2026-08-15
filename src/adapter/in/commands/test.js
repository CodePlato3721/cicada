import { SlashCommandBuilder } from 'discord.js';
import { getVoiceConnection } from '@discordjs/voice';
import { playPcmInChannel } from '../../out/playback.js';

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

// 生成一段简单的三音符旋律（A4-C#5-E5），48kHz 立体声 16-bit PCM，纯本地合成，不依赖任何外部文件。
function generateTestMelodyPcm() {
  const sampleRate = 48000;
  const notes = [440, 554.37, 659.25]; // A4, C#5, E5
  const noteDurationSec = 0.6;
  const gapSec = 0.05;
  const volume = 0.3;

  const chunks = notes.map((freq) => {
    const n = Math.round(sampleRate * noteDurationSec);
    const buf = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) {
      const sample = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * volume * 32767);
      buf.writeInt16LE(sample, i * 4);
      buf.writeInt16LE(sample, i * 4 + 2);
    }
    const gapN = Math.round(sampleRate * gapSec);
    return Buffer.concat([buf, Buffer.alloc(gapN * 4)]);
  });

  return Buffer.concat(chunks);
}
