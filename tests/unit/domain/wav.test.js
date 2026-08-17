// domain/wav.js 的 WAV 解析/重采样是纯函数，用手工构造的 WAV buffer 验证，
// 不需要真实音频文件或外部 API。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWav, upsampleMono24kToStereo48k, ttsWavToDiscordPcm } from '../../../dist/domain/wav.js';

// 构造一个最小合法的标准 PCM WAV：RIFF/WAVE 头 + fmt chunk(16字节) + data chunk。
function buildWav({ channels, sampleRate, bitsPerSample, samples }) {
  const bytesPerSample = bitsPerSample / 8;
  const dataBuffer = Buffer.alloc(samples.length * bytesPerSample);
  samples.forEach((sample, i) => dataBuffer.writeInt16LE(sample, i * bytesPerSample));

  const fmtChunk = Buffer.alloc(24);
  fmtChunk.write('fmt ', 0, 'ascii');
  fmtChunk.writeUInt32LE(16, 4); // fmt chunk size
  fmtChunk.writeUInt16LE(1, 8); // PCM
  fmtChunk.writeUInt16LE(channels, 10);
  fmtChunk.writeUInt32LE(sampleRate, 12);
  fmtChunk.writeUInt32LE(sampleRate * channels * bytesPerSample, 16); // byte rate
  fmtChunk.writeUInt16LE(channels * bytesPerSample, 20); // block align
  fmtChunk.writeUInt16LE(bitsPerSample, 22);

  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0, 'ascii');
  dataHeader.writeUInt32LE(dataBuffer.length, 4);

  const riffBody = Buffer.concat([fmtChunk, dataHeader, dataBuffer]);
  const riffHeader = Buffer.alloc(12);
  riffHeader.write('RIFF', 0, 'ascii');
  riffHeader.writeUInt32LE(4 + riffBody.length, 4);
  riffHeader.write('WAVE', 8, 'ascii');

  return Buffer.concat([riffHeader, riffBody]);
}

test('parseWav：能正确解出 fmt/data chunk 字段', () => {
  const wav = buildWav({ channels: 1, sampleRate: 24000, bitsPerSample: 16, samples: [1, 2, 3, -1] });
  const parsed = parseWav(wav);

  assert.equal(parsed.channels, 1);
  assert.equal(parsed.sampleRate, 24000);
  assert.equal(parsed.bitsPerSample, 16);
  assert.equal(parsed.data.length, 8);
  assert.equal(parsed.data.readInt16LE(0), 1);
  assert.equal(parsed.data.readInt16LE(6), -1);
});

test('parseWav：不是 RIFF/WAVE 头就抛错', () => {
  const garbage = Buffer.from('not a wav file at all...');
  assert.throws(() => parseWav(garbage), /Not a valid WAV file/);
});

test('parseWav：缺 data chunk 就抛错', () => {
  const fmtOnly = buildWav({ channels: 1, sampleRate: 24000, bitsPerSample: 16, samples: [] });
  // buildWav 总会带 data chunk（哪怕是空的），这里改造成真的没有 data chunk：
  // 直接从一个只有 fmt chunk、手动拼出的 buffer 验证。
  const fmtChunk = Buffer.alloc(24);
  fmtChunk.write('fmt ', 0, 'ascii');
  fmtChunk.writeUInt32LE(16, 4);
  fmtChunk.writeUInt16LE(1, 8);
  fmtChunk.writeUInt16LE(1, 10);
  fmtChunk.writeUInt32LE(24000, 12);
  fmtChunk.writeUInt32LE(48000, 16);
  fmtChunk.writeUInt16LE(2, 20);
  fmtChunk.writeUInt16LE(16, 22);
  const riffHeader = Buffer.alloc(12);
  riffHeader.write('RIFF', 0, 'ascii');
  riffHeader.writeUInt32LE(4 + fmtChunk.length, 4);
  riffHeader.write('WAVE', 8, 'ascii');
  const noDataWav = Buffer.concat([riffHeader, fmtChunk]);

  assert.throws(() => parseWav(noDataWav), /missing the fmt or data chunk/);
  // fmtOnly（空 data chunk）应该能正常解析，只是 data 长度为 0——顺带验证空 data 不会被
  // 误判成"没有 data chunk"（data !== null 只要 chunk 出现过，即便长度是 0）。
  assert.equal(parseWav(fmtOnly).data.length, 0);
});

test('upsampleMono24kToStereo48k：采样数翻倍，输出立体声交织', () => {
  const mono = Buffer.alloc(4);
  mono.writeInt16LE(1000, 0);
  mono.writeInt16LE(2000, 2);

  const out = upsampleMono24kToStereo48k(mono);

  // 2 输入采样 → 4 输出采样（2倍）× 2 声道 × 2 字节 = 16 字节
  assert.equal(out.length, 16);
  // 第 0 帧：原样复制第一个采样，左右声道相同
  assert.equal(out.readInt16LE(0), 1000);
  assert.equal(out.readInt16LE(2), 1000);
  // 第 1 帧：两个原始采样的线性插值中点
  assert.equal(out.readInt16LE(4), 1500);
  assert.equal(out.readInt16LE(6), 1500);
});

test('ttsWavToDiscordPcm：24kHz 单声道 16bit 输入能正确转成 48kHz 立体声', () => {
  const wav = buildWav({ channels: 1, sampleRate: 24000, bitsPerSample: 16, samples: [100, 200, 300, 400] });
  const pcm = ttsWavToDiscordPcm(wav, { speed: 1 });

  // 4 输入采样 → 8 输出采样 × 2 声道 × 2 字节 = 32 字节
  assert.equal(pcm.length, 32);
});

test('ttsWavToDiscordPcm：格式跟预期(24kHz/单声道/16bit)不符就抛错', () => {
  const wrongFormatWav = buildWav({ channels: 2, sampleRate: 24000, bitsPerSample: 16, samples: [1, 2] });
  assert.throws(() => ttsWavToDiscordPcm(wrongFormatWav), /doesn't match expectations/);
});
