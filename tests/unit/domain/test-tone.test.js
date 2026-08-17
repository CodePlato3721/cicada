// domain/test-tone.js 是纯函数（本地合成三音符旋律，不依赖外部文件/网络），
// 用固定的采样率/时长参数反推期望的 buffer 大小来验证，不校验音色本身。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTestMelodyPcm } from '../../../dist/domain/test-tone.js';

test('generateTestMelodyPcm：返回符合预期长度的 48kHz 立体声 16-bit PCM buffer', () => {
  const pcm = generateTestMelodyPcm();

  // 跟源码里的参数保持一致：3 个音符，每个 0.6s 音符 + 0.05s 间隔，48kHz 立体声 16-bit
  // （4 字节/采样点：2 声道 × 2 字节）。
  const sampleRate = 48000;
  const noteSamples = Math.round(sampleRate * 0.6);
  const gapSamples = Math.round(sampleRate * 0.05);
  const bytesPerNote = (noteSamples + gapSamples) * 4;
  const expectedLength = bytesPerNote * 3;

  assert.ok(Buffer.isBuffer(pcm));
  assert.equal(pcm.length, expectedLength);
});

test('generateTestMelodyPcm：不是全零静音，确实合成出了波形', () => {
  const pcm = generateTestMelodyPcm();
  let hasNonZeroSample = false;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    if (pcm.readInt16LE(i) !== 0) {
      hasNonZeroSample = true;
      break;
    }
  }
  assert.ok(hasNonZeroSample);
});

test('generateTestMelodyPcm：左右声道完全一致（单声道内容复制成立体声）', () => {
  const pcm = generateTestMelodyPcm();
  for (let frame = 0; frame < 10; frame++) {
    const left = pcm.readInt16LE(frame * 4);
    const right = pcm.readInt16LE(frame * 4 + 2);
    assert.equal(left, right);
  }
});
