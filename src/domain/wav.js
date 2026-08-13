// 极简 WAV 解析：够用即可，只处理标准 PCM 格式（fmt / data 两个 chunk）。
export function parseWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是有效的 WAV 文件');
  }

  let offset = 12;
  let fmt = null;
  let data = null;

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

    // chunk 按偶数字节对齐
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (!fmt || !data) {
    throw new Error('WAV 缺少 fmt 或 data chunk');
  }

  return { ...fmt, data };
}

// 把 16-bit 单声道 PCM 用线性插值升采样 2 倍，并复制成双声道。
// Groq TTS(Orpheus)固定输出 24kHz 单声道，Discord 播放要求 48kHz 立体声，正好差 2 倍。
export function upsampleMono24kToStereo48k(monoBuffer) {
  const inSamples = monoBuffer.length / 2;
  const outSamples = inSamples * 2;
  const out = Buffer.alloc(outSamples * 4); // 2 bytes/sample * 2 声道

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

// 按比例压缩时间轴（线性插值），等效于放快播放——Groq 的 speed 参数实测对 Orpheus 不生效，
// 只能自己在本地处理。副作用：倍率越大，音调会跟着变高（跟磁带加速播放一个道理）。
function speedUpMonoInt16(buffer, speed) {
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

// Groq TTS 返回的 wav Buffer → Discord 播放要求的 48kHz 立体声 16-bit PCM Buffer
export function ttsWavToDiscordPcm(wavBuffer, { speed = Number(process.env.TTS_SPEED ?? 1) } = {}) {
  const { channels, sampleRate, bitsPerSample, data } = parseWav(wavBuffer);

  if (channels !== 1 || sampleRate !== 24000 || bitsPerSample !== 16) {
    throw new Error(
      `TTS 音频格式跟预期不一致（channels=${channels}, sampleRate=${sampleRate}, bitsPerSample=${bitsPerSample}），需要调整转换逻辑`,
    );
  }

  return upsampleMono24kToStereo48k(speedUpMonoInt16(data, speed));
}
