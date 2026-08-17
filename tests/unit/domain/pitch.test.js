// domain/pitch.js 的基频估计是纯函数（自相关法，不依赖外部 IO），用合成的正弦波
// 驱动测试——不追求声学精度，只验证"给定已知基频的输入，能大致估计对方向"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateGender } from '../../../dist/domain/pitch.js';

const SAMPLE_RATE = 16000; // 必须跟 pitch.js 内部假设的采样率一致

// 生成一段纯正弦波，模拟某个基频的浊音——estimateGender 靠自相关找周期性，
// 正弦波是最干净的周期信号，足以验证估计方向是否正确。
function generateTone(freqHz, durationSec = 1, amplitude = 0.8) {
  const n = Math.round(SAMPLE_RATE * durationSec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / SAMPLE_RATE);
  }
  return out;
}

test('estimateGender：低于阈值的基频判为 male', () => {
  const tone = generateTone(100); // 默认阈值 165Hz，100Hz 明显偏低
  const result = estimateGender(tone);

  assert.equal(result.gender, 'male');
  assert.ok(result.voicedFrames > 0);
  assert.ok(result.medianHz !== null && Math.abs(result.medianHz - 100) < 5);
});

test('estimateGender：高于阈值的基频判为 female', () => {
  const tone = generateTone(300); // 明显偏高
  const result = estimateGender(tone);

  assert.equal(result.gender, 'female');
  assert.ok(result.medianHz !== null && Math.abs(result.medianHz - 300) < 15);
});

test('estimateGender：静音输入返回 unknown，不误判', () => {
  const silence = new Float32Array(SAMPLE_RATE); // 全 0，1 秒静音
  const result = estimateGender(silence);

  assert.deepEqual(result, { gender: 'unknown', medianHz: null, voicedFrames: 0 });
});

test('estimateGender：自定义阈值会改变判断结果', () => {
  const tone = generateTone(180); // 默认阈值(165)下应该是 female
  assert.equal(estimateGender(tone).gender, 'female');
  // 把阈值抬高到 200，同一段 180Hz 的音频就该判成 male
  assert.equal(estimateGender(tone, 200).gender, 'male');
});
