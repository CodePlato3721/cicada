export interface ParsedWav {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  data: Buffer;
}

export function parseWav(buffer: Buffer): ParsedWav {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a valid WAV file');
  }

  let offset = 12;
  let fmt: { channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let data: Buffer | null = null;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;

    if (chunkId === 'fmt ') {
      fmt = {
        channels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14),
      };
    } else if (chunkId === 'data') {
      data = buffer.subarray(chunkStart, chunkStart + chunkSize);
    }

    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (!fmt || !data) {
    throw new Error('WAV is missing the fmt or data chunk');
  }

  return { ...fmt, data };
}

export function upsampleMono24kToStereo48k(monoBuffer: Buffer): Buffer {
  const inSamples = monoBuffer.length / 2;
  const outSamples = inSamples * 2;
  const out = Buffer.alloc(outSamples * 4);

  for (let i = 0; i < inSamples; i++) {
    const s0 = monoBuffer.readInt16LE(i * 2);
    const s1 = i + 1 < inSamples ? monoBuffer.readInt16LE((i + 1) * 2) : s0;
    const mid = Math.round((s0 + s1) / 2);

    const frame0 = 2 * i;
    const frame1 = frame0 + 1;

    out.writeInt16LE(s0, frame0 * 4);
    out.writeInt16LE(s0, frame0 * 4 + 2);
    out.writeInt16LE(mid, frame1 * 4);
    out.writeInt16LE(mid, frame1 * 4 + 2);
  }

  return out;
}

function speedUpMonoInt16(buffer: Buffer, speed: number): Buffer {
  if (speed === 1) return buffer;

  const inSamples = buffer.length / 2;
  const outSamples = Math.max(1, Math.floor(inSamples / speed));
  const out = Buffer.alloc(outSamples * 2);

  for (let i = 0; i < outSamples; i++) {
    const srcPos = i * speed;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, inSamples - 1);
    const frac = srcPos - i0;
    const s0 = buffer.readInt16LE(i0 * 2);
    const s1 = buffer.readInt16LE(i1 * 2);
    out.writeInt16LE(Math.round(s0 + (s1 - s0) * frac), i * 2);
  }

  return out;
}

export interface TtsWavToDiscordPcmOptions {
  speed?: number;
}

export function ttsWavToDiscordPcm(
  wavBuffer: Buffer,
  { speed = Number(process.env.TTS_SPEED ?? 1) }: TtsWavToDiscordPcmOptions = {},
): Buffer {
  const { channels, sampleRate, bitsPerSample, data } = parseWav(wavBuffer);

  if (channels !== 1 || sampleRate !== 24000 || bitsPerSample !== 16) {
    throw new Error(
      `TTS audio format doesn't match expectations (channels=${channels}, sampleRate=${sampleRate}, bitsPerSample=${bitsPerSample}), conversion logic needs adjusting`,
    );
  }

  return upsampleMono24kToStereo48k(speedUpMonoInt16(data, speed));
}
