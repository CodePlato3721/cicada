import wav from 'wav';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { monoFloat32ToInt16Buffer } from '../../domain/pcm.js';
import { createLogger } from './logger.js';

const logger = createLogger('recordings');

const RECORDINGS_DIR = process.env.RECORDINGS_DIR;
const SAVE_RECORDINGS = process.env.SAVE_RECORDINGS !== 'false';
const RETENTION_HOURS = Number(process.env.RECORDINGS_RETENTION_HOURS ?? 24);
const PRUNE_INTERVAL_MS = 5 * 60_000;

if (SAVE_RECORDINGS && !RECORDINGS_DIR) {
  throw new Error('Environment variable RECORDINGS_DIR is not set — configure a debug recordings directory in .env');
}

async function ensureDir(): Promise<void> {
  await mkdir(RECORDINGS_DIR as string, { recursive: true });
}

async function writeMonoWav(filename: string, monoFloat32: Float32Array, sampleRate: number): Promise<void> {
  const writer = new wav.Writer({ sampleRate, channels: 1, bitDepth: 16 });
  const fileStream = createWriteStream(filename);
  const finished = new Promise<void>((resolve, reject) => {
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
  });

  writer.pipe(fileStream);
  writer.end(monoFloat32ToInt16Buffer(monoFloat32));
  await finished;
}

export async function saveInputRecording(
  userId: string,
  stamp: string | number,
  monoFloat32: Float32Array,
  sampleRate: number,
): Promise<void> {
  if (!SAVE_RECORDINGS) return;

  await ensureDir();
  pruneOldRecordings().catch((err) => logger.error({ err }, 'Failed to prune old recordings'));
  const filename = join(RECORDINGS_DIR as string, `${userId}-${stamp}.wav`);
  await writeMonoWav(filename, monoFloat32, sampleRate);
}

export async function saveOutputRecording(userId: string, stamp: string | number, wavBuffer: Buffer): Promise<void> {
  if (!SAVE_RECORDINGS) return;
  await ensureDir();
  await writeFile(join(RECORDINGS_DIR as string, `${userId}-${stamp}-tts.wav`), wavBuffer);
}

let lastPruneAt = 0;

async function pruneOldRecordings(): Promise<void> {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;

  const cutoff = now - RETENTION_HOURS * 3600_000;
  const files = await readdir(RECORDINGS_DIR as string).catch(() => [] as string[]);

  await Promise.all(
    files.map(async (name) => {
      const full = join(RECORDINGS_DIR as string, name);
      const info = await stat(full).catch(() => null);
      if (info && info.mtimeMs < cutoff) {
        await unlink(full).catch(() => {});
      }
    }),
  );
}
