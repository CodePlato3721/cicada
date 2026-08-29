export function stereoInt16BufferToMonoFloat32(buffer: Buffer): Float32Array {
  const bytesPerFrame = 4;
  const sampleCount = Math.floor(buffer.length / bytesPerFrame);
  const out = new Float32Array(sampleCount);

  for (let i = 0; i < sampleCount; i++) {
    const left = buffer.readInt16LE(i * bytesPerFrame);
    const right = buffer.readInt16LE(i * bytesPerFrame + 2);
    out[i] = (left + right) / 2 / 32768;
  }

  return out;
}

export function monoFloat32ToInt16Buffer(float32Array: Float32Array): Buffer {
  const buffer = Buffer.alloc(float32Array.length * 2);

  for (let i = 0; i < float32Array.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32Array[i]));
    buffer.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }

  return buffer;
}
