export function generateTestMelodyPcm(): Buffer {
  const sampleRate = 48000;
  const notes = [440, 554.37, 659.25];
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
