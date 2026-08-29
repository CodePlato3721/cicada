const SAMPLE_RATE = 16000;
const MIN_HZ = 70;
const MAX_HZ = 400;
const FRAME_MS = 40;
const HOP_MS = 20;
const FRAME_SAMPLES = Math.round((SAMPLE_RATE * FRAME_MS) / 1000);
const HOP_SAMPLES = Math.round((SAMPLE_RATE * HOP_MS) / 1000);
const MIN_LAG = Math.floor(SAMPLE_RATE / MAX_HZ);
const MAX_LAG = Math.ceil(SAMPLE_RATE / MIN_HZ);
const MIN_CORRELATION = 0.3;

export type Gender = 'male' | 'female' | 'unknown';

export interface GenderEstimate {
  gender: Gender;
  medianHz: number | null;
  voicedFrames: number;
}

function estimateFramePitchHz(frame: Float32Array): number | null {
  let mean = 0;
  for (let i = 0; i < frame.length; i++) mean += frame[i];
  mean /= frame.length;

  let energy = 0;
  for (let i = 0; i < frame.length; i++) energy += (frame[i] - mean) ** 2;
  if (energy < 1e-6) return null;

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
