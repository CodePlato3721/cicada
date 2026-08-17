// 简单的基频（F0）估计：自相关法，只为了粗略判断"听起来偏男声还是偏女声"，
// 不是严谨的声学分析——嗓音偏低的女声/偏高的男声会判错，这里接受这个误差，
// 目的只是给每个说话人挑一个音色池子，做出区分度即可。
//
// 人声基频大致范围：男声 85-180Hz，女声 165-255Hz，中间有重叠，越靠近阈值越不可靠。
const SAMPLE_RATE = 16000; // 跟 VAD 输出的语音段采样率一致（domain/streaming-vad.js）
const MIN_HZ = 70; // 覆盖男声下限，留点余量
const MAX_HZ = 400; // 覆盖女声上限，留点余量
const FRAME_MS = 40;
const HOP_MS = 20;
const FRAME_SAMPLES = Math.round((SAMPLE_RATE * FRAME_MS) / 1000);
const HOP_SAMPLES = Math.round((SAMPLE_RATE * HOP_MS) / 1000);
const MIN_LAG = Math.floor(SAMPLE_RATE / MAX_HZ);
const MAX_LAG = Math.ceil(SAMPLE_RATE / MIN_HZ);
// 自相关系数低于这个值说明这一帧不像清晰的浊音（元音）基频，丢弃不用。
const MIN_CORRELATION = 0.3;

export type Gender = 'male' | 'female' | 'unknown';

export interface GenderEstimate {
  gender: Gender;
  medianHz: number | null;
  voicedFrames: number;
}

// 对一帧做自相关，返回相关性最强的滞后对应的基频（Hz）；太安静/不够周期性就返回 null。
function estimateFramePitchHz(frame: Float32Array): number | null {
  let mean = 0;
  for (let i = 0; i < frame.length; i++) mean += frame[i];
  mean /= frame.length;

  let energy = 0;
  for (let i = 0; i < frame.length; i++) energy += (frame[i] - mean) ** 2;
  if (energy < 1e-6) return null; // 基本静音

  let bestLag = -1;
  let bestCorr = 0;
  for (let lag = MIN_LAG; lag <= MAX_LAG && lag < frame.length; lag++) {
    let corr = 0;
    for (let i = 0; i + lag < frame.length; i++) {
      corr += (frame[i] - mean) * (frame[i + lag] - mean);
    }
    corr /= energy;
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }

  if (bestLag < 0 || bestCorr < MIN_CORRELATION) return null;
  return SAMPLE_RATE / bestLag;
}

// monoFloat32：16kHz 单声道语音段（VAD 切出来的那一段）。
export function estimateGender(
  monoFloat32: Float32Array,
  thresholdHz: number = Number(process.env.GENDER_PITCH_THRESHOLD_HZ ?? 165),
): GenderEstimate {
  const pitches: number[] = [];

  for (let start = 0; start + FRAME_SAMPLES <= monoFloat32.length; start += HOP_SAMPLES) {
    const frame = monoFloat32.subarray(start, start + FRAME_SAMPLES);
    const hz = estimateFramePitchHz(frame);
    if (hz !== null) pitches.push(hz);
  }

  if (pitches.length === 0) {
    return { gender: 'unknown', medianHz: null, voicedFrames: 0 };
  }

  pitches.sort((a, b) => a - b);
  const medianHz = pitches[Math.floor(pitches.length / 2)];

  return {
    gender: medianHz < thresholdHz ? 'male' : 'female',
    medianHz,
    voicedFrames: pitches.length,
  };
}
