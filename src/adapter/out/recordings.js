import wav from 'wav';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile, readdir, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monoFloat32ToInt16Buffer } from '../../domain/pcm.js';
import { createLogger } from './logger.js';

const logger = createLogger('recordings');

// 把语音段落盘成 wav 文件。输入段这份不是纯调试用途——Groq STT 的 SDK 要求传文件路径
// （内部用 createReadStream 读取），所以这次落盘是主链路里必须的一步；
// 输出（TTS 结果）这份纯粹是调试留痕，方便回放排查翻译/合成效果，不影响播放本身。
//
// 默认两份都留（跟原来行为一致，方便调试），但 RECORDINGS_DIR 会按 RECORDINGS_RETENTION_HOURS
// 自动清理旧文件，不会无限增长。不想攒盘就设 SAVE_RECORDINGS=false：这时输入录音只临时写到
// 系统 temp 目录、喂完 STT 立刻删（主链路照常工作），输出录音直接跳过不写。
const RECORDINGS_DIR = process.env.RECORDINGS_DIR;
const SAVE_RECORDINGS = process.env.SAVE_RECORDINGS !== 'false';
const RETENTION_HOURS = Number(process.env.RECORDINGS_RETENTION_HOURS ?? 24);
// 清理只在写入时顺手做，加个节流，不用每句话都扫一遍目录。
const PRUNE_INTERVAL_MS = 5 * 60_000;

if (SAVE_RECORDINGS && !RECORDINGS_DIR) {
  throw new Error('环境变量 RECORDINGS_DIR 未设置，请在 .env 里配置调试录音保存目录');
}

async function ensureDir() {
  await mkdir(RECORDINGS_DIR, { recursive: true });
}

async function writeMonoWav(filename, monoFloat32, sampleRate) {
  const writer = new wav.Writer({ sampleRate, channels: 1, bitDepth: 16 });
  const fileStream = createWriteStream(filename);
  const finished = new Promise((resolve, reject) => {
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
  });

  writer.pipe(fileStream);
  writer.end(monoFloat32ToInt16Buffer(monoFloat32));
  await finished;
}

// 返回写入的文件路径，调用方（application/pipeline.js）要拿它去喂 STT，
// 用完后应该调用 deleteRecording(filePath) 收尾（SAVE_RECORDINGS=true 时是 no-op，留档）。
export async function saveInputRecording(userId, stamp, monoFloat32, sampleRate) {
  if (!SAVE_RECORDINGS) {
    const filename = join(tmpdir(), `dc-translate-${userId}-${stamp}.wav`);
    await writeMonoWav(filename, monoFloat32, sampleRate);
    return filename;
  }

  await ensureDir();
  pruneOldRecordings().catch((err) => logger.error({ err }, '清理旧录音失败'));
  const filename = join(RECORDINGS_DIR, `${userId}-${stamp}.wav`);
  await writeMonoWav(filename, monoFloat32, sampleRate);
  return filename;
}

// STT 用完这份输入录音之后调用。SAVE_RECORDINGS=false 时清掉 temp 文件；
// =true 时这份是留存证据，不删。
export async function deleteRecording(filePath) {
  if (SAVE_RECORDINGS) return;
  await unlink(filePath).catch(() => {});
}

export async function saveOutputRecording(userId, stamp, wavBuffer) {
  if (!SAVE_RECORDINGS) return; // 纯调试用途，不保留就跳过，不占盘
  await ensureDir();
  await writeFile(join(RECORDINGS_DIR, `${userId}-${stamp}-tts.wav`), wavBuffer);
}

let lastPruneAt = 0;

async function pruneOldRecordings() {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;

  const cutoff = now - RETENTION_HOURS * 3600_000;
  const files = await readdir(RECORDINGS_DIR).catch(() => []);

  await Promise.all(
    files.map(async (name) => {
      const full = join(RECORDINGS_DIR, name);
      const info = await stat(full).catch(() => null);
      if (info && info.mtimeMs < cutoff) {
        await unlink(full).catch(() => {});
      }
    }),
  );
}
