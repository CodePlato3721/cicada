// domain/pcm.js 是纯函数（PCM 格式转换，不依赖外部 IO/网络），适合单元测试直接验证。
// 导入路径固定指向 dist/ 编译产物，跟 tests/e2e 的约定一致（见 CCD-1 TASK-02 CR）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stereoInt16BufferToMonoFloat32, monoFloat32ToInt16Buffer } from '../../../dist/domain/pcm.js';

test('stereoInt16BufferToMonoFloat32：左右声道取平均并归一化到 [-1, 1]', () => {
  // 两帧：第一帧左右声道相同（10000, 10000），第二帧左右声道不同（-20000, 0）。
  const buffer = Buffer.alloc(8);
  buffer.writeInt16LE(10000, 0);
  buffer.writeInt16LE(10000, 2);
  buffer.writeInt16LE(-20000, 4);
  buffer.writeInt16LE(0, 6);

  const mono = stereoInt16BufferToMonoFloat32(buffer);

  assert.equal(mono.length, 2);
  assert.ok(Math.abs(mono[0] - 10000 / 32768) < 1e-9);
  assert.ok(Math.abs(mono[1] - -10000 / 32768) < 1e-9);
});

test('stereoInt16BufferToMonoFloat32：不足一帧（4字节）的尾部字节被丢弃', () => {
  const buffer = Buffer.alloc(6); // 1 帧 + 2 个多余字节
  buffer.writeInt16LE(100, 0);
  buffer.writeInt16LE(100, 2);

  const mono = stereoInt16BufferToMonoFloat32(buffer);
  assert.equal(mono.length, 1);
});

test('monoFloat32ToInt16Buffer：正常范围内按比例转换', () => {
  const input = new Float32Array([0, 0.5, -0.5]);
  const buffer = monoFloat32ToInt16Buffer(input);

  assert.equal(buffer.length, 6);
  assert.equal(buffer.readInt16LE(0), 0);
  assert.equal(buffer.readInt16LE(2), Math.round(0.5 * 32767));
  assert.equal(buffer.readInt16LE(4), Math.round(-0.5 * 32767));
});

test('monoFloat32ToInt16Buffer：超出 [-1, 1] 的输入会被裁剪，不溢出', () => {
  const input = new Float32Array([2, -2]);
  const buffer = monoFloat32ToInt16Buffer(input);

  assert.equal(buffer.readInt16LE(0), 32767);
  assert.equal(buffer.readInt16LE(2), -32767);
});
