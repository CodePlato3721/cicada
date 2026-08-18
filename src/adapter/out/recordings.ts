import wav from 'wav';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { monoFloat32ToInt16Buffer } from '../../domain/pcm.js';
import { createLogger } from './logger.js';

const logger = createLogger('recordings');

// 把语音段落盘成 wav 文件。STT 从 CCD-2 TASK-01 起改成流式（VAD 边界一确定就直接
// 拿到转写结果），不再需要先把整句话落盘成文件再喂给供应商——输入/输出这两份录音
// 现在都纯粹是调试留痕，方便回放排查转写/翻译/合成效果，不影响主链路本身。
//
// 调用方（adapter/in/voice-listener.js）在 VAD 判定这句话说完、拿到完整 monoFloat32
// 的同一时刻另起一个不 await 的异步任务调用 saveInputRecording——这是跟主链路
// （流式转录 → handleSegment）并行的旁路备份，不阻塞转写结果的返回和下游触发；
// 备份写入失败只 .catch() 打日志，不能拖慢或中断主链路。
//
// 默认两份都留，但 RECORDINGS_DIR 会按 RECORDINGS_RETENTION_HOURS 自动清理旧文件，
// 不会无限增长。不想攒盘就设 SAVE_RECORDINGS=false：两份都直接跳过、不落盘
// （没有下游会再读这份文件，不需要像以前那样临时写到系统 temp 目录）。
const RECORDINGS_DIR = process.env.RECORDINGS_DIR;
const SAVE_RECORDINGS = process.env.SAVE_RECORDINGS !== 'false';
const RETENTION_HOURS = Number(process.env.RECORDINGS_RETENTION_HOURS ?? 24);
// 清理只在写入时顺手做，加个节流，不用每句话都扫一遍目录。
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

// 纯粹的旁路调试备份——不再返回文件路径（没有下游会拿它去喂 STT 了，见上面模块注释）。
// SAVE_RECORDINGS=false 时直接跳过、不落盘、不写 temp 文件。
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
  if (!SAVE_RECORDINGS) return; // 纯调试用途，不保留就跳过，不占盘
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
