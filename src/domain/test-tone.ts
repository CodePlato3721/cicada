// 生成一段简单的三音符旋律（A4-C#5-E5），48kHz 立体声 16-bit PCM，纯本地合成，不依赖
// 任何外部文件/TTS 供应商——用来验证"播放 PCM 到语音频道"这条链路本身通不通，跟 STT/
// 翻译/TTS 这些外部依赖完全隔离。/test 命令和 /join 之后的首次播放自检都用这一份，
// 不重复写两遍。
export function generateTestMelodyPcm(): Buffer {
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
