import { EndBehaviorType, type VoiceConnection, type AudioReceiveStream } from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import prism from 'prism-media';
import type { opus } from 'prism-media';
import { StreamingVad } from '../../domain/streaming-vad.js';
import { getKeyterms } from '../../domain/keyterms.js';
import { clearPlaybackQueue, markMaking } from '../out/playback-queue.js';
import { saveInputRecording } from '../out/recordings.js';
import { handleSegment } from '../../application/pipeline.js';
import {
  hydrateSessionBillingState,
  syncBillingStateToDb,
  finalizeSessionLedger,
  checkSttAllowed,
  sendSttBlockedNotice,
} from '../../application/billing/billing-service.js';
import { openStream, type SttStream, type TranscribeResult } from '../../application/ports/stt.js';
import {
  createSession,
  getSession,
  deleteSession,
  addSpeaker,
  getSpeaker,
  nextPlaybackSequence,
  type SpeakerState,
} from '../../application/session.js';
import { createLogger } from '../out/logger.js';

const logger = createLogger('listener');
const AUDIO_DIAGNOSTICS_ENABLED = process.env.VOICE_AUDIO_DIAGNOSTICS !== 'false';
const AUDIO_DIAGNOSTICS_INTERVAL_MS = Number(process.env.VOICE_AUDIO_DIAGNOSTICS_INTERVAL_MS ?? 5000);

interface PcmAudioStats {
  sampleCount: number;
  sumSquares: number;
  peak: number;
}

function updatePcmAudioStats(stats: PcmAudioStats, chunk: Buffer): void {
  for (let offset = 0; offset + 1 < chunk.length; offset += 2) {
    const sample = chunk.readInt16LE(offset) / 32768;
    const abs = Math.abs(sample);
    stats.sumSquares += sample * sample;
    stats.sampleCount += 1;
    if (abs > stats.peak) stats.peak = abs;
  }
}

function roundedLevel(value: number): number {
  return Number(value.toFixed(4));
}

interface SpeakerVoiceRuntime {
  vad: StreamingVad;
  opusStream: AudioReceiveStream;
  decoder: opus.Decoder;
  forceEndSpeech: () => void;
}

interface GuildVoiceRuntime {
  connection: VoiceConnection;
  voiceChannel: VoiceBasedChannel;
  speakers: Map<string, SpeakerVoiceRuntime>;
}

interface GuildListeners {
  onSpeakingStart: (userId: string) => void;
  onSpeakingEnd: (userId: string) => void;
}

const guildListeners = new Map<string, GuildListeners>();
const guildVoiceRuntimes = new Map<string, GuildVoiceRuntime>();
const startingSpeakerPipelines = new Set<string>();

const BILLING_SYNC_INTERVAL_MS = 60 * 1000;
const billingSyncTimers = new Map<string, NodeJS.Timeout>();

function startBillingSync(guildId: string): void {
  stopBillingSync(guildId);
  const timer = setInterval(() => {
    void syncBillingStateToDb(guildId).catch((err) => logger.error({ err, guildId }, `Failed to sync billing state for guild ${guildId}`));
  }, BILLING_SYNC_INTERVAL_MS);
  timer.unref?.();
  billingSyncTimers.set(guildId, timer);
}

function stopBillingSync(guildId: string): void {
  const timer = billingSyncTimers.get(guildId);
  if (timer) {
    clearInterval(timer);
    billingSyncTimers.delete(guildId);
  }
}

function speakerRuntimeKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

function getSpeakerVoiceRuntime(guildId: string, userId: string): SpeakerVoiceRuntime | undefined {
  return guildVoiceRuntimes.get(guildId)?.speakers.get(userId);
}

function hasSpeakerVoiceRuntime(guildId: string, userId: string): boolean {
  return guildVoiceRuntimes.get(guildId)?.speakers.has(userId) ?? false;
}

export async function startListening(connection: VoiceConnection, voiceChannel: VoiceBasedChannel): Promise<void> {
  const guildId = connection.joinConfig.guildId;

  await stopListening(guildId);

  await createSession(guildId);
  await hydrateSessionBillingState(guildId);
  startBillingSync(guildId);
  guildVoiceRuntimes.set(guildId, { connection, voiceChannel, speakers: new Map() });

  const onSpeakingStart = (userId: string) => {
    logger.info({ userId }, `${userId} Discord detected speaking started`);
    const key = speakerRuntimeKey(guildId, userId);
    const hasRuntime = hasSpeakerVoiceRuntime(guildId, userId);
    const isStarting = startingSpeakerPipelines.has(key);
    if (hasRuntime || isStarting) {
      logger.info(
        { event: 'speaker_pipeline_reused', guildId, userId, hasRuntime, isStarting },
        `${userId} speaker pipeline already active or starting`,
      );
      return;
    }
    startingSpeakerPipelines.add(key);
    createSpeakerPipeline(guildId, connection, voiceChannel, userId)
      .catch((err) => {
        logger.error({ err, userId }, `Failed to initialize listening for speaker ${userId}`);
      })
      .finally(() => {
        startingSpeakerPipelines.delete(key);
      });
  };

  const onSpeakingEnd = (userId: string) => {
    getSpeakerVoiceRuntime(guildId, userId)?.forceEndSpeech();
  };

  guildListeners.set(guildId, { onSpeakingStart, onSpeakingEnd });
  connection.receiver.speaking.on('start', onSpeakingStart);
  connection.receiver.speaking.on('end', onSpeakingEnd);

  logger.info({ guildId }, `Started auto-listening to voice in guild ${guildId}`);
}

export async function stopListening(guildId: string): Promise<void> {
  const runtime = guildVoiceRuntimes.get(guildId);
  if (!runtime && !(await getSession(guildId))) return;

  const listeners = guildListeners.get(guildId);
  if (listeners) {
    if (runtime) {
      runtime.connection.receiver.speaking.off('start', listeners.onSpeakingStart);
      runtime.connection.receiver.speaking.off('end', listeners.onSpeakingEnd);
    }
    guildListeners.delete(guildId);
  }

  for (const speakerRuntime of runtime?.speakers.values() ?? []) {
    speakerRuntime.opusStream.destroy();
    speakerRuntime.decoder.destroy();
    speakerRuntime.vad.destroy().catch(() => {});
  }

  for (const key of Array.from(startingSpeakerPipelines)) {
    if (key.startsWith(`${guildId}:`)) startingSpeakerPipelines.delete(key);
  }

  guildVoiceRuntimes.delete(guildId);
  stopBillingSync(guildId);
  await finalizeSessionLedger(guildId).catch((err) => logger.error({ err, guildId }, `Failed to finalize session ledger for guild ${guildId}`));
  await deleteSession(guildId);
  clearPlaybackQueue(guildId);
  logger.info({ guildId }, `Stopped listening to guild ${guildId}`);
}

type SpeakerJob = { type: 'chunk'; data: Buffer } | { type: 'forceEnd' };

async function createSpeakerPipeline(
  guildId: string,
  connection: VoiceConnection,
  voiceChannel: VoiceBasedChannel,
  userId: string,
): Promise<void> {
  logger.info({ event: 'speaker_pipeline_create_start', guildId, userId }, `${userId} creating speaker pipeline`);
  const vad = await StreamingVad.create();
  const guildRuntime = guildVoiceRuntimes.get(guildId);
  if (!guildRuntime) {
    await vad.destroy();
    return;
  }

  const opusStream = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.Manual },
  });
  logger.info({ event: 'discord_opus_stream_subscribed', guildId, userId }, `${userId} Discord opus stream subscribed`);
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });

  opusStream.pipe(decoder);

  let speakerState = await getSpeaker(guildId, userId);
  if (!speakerState) {
    speakerState = {
      lastTranscript: '',
    };
    await addSpeaker(guildId, userId, speakerState);
  } else {
    logger.info(
      { event: 'speaker_state_reused', guildId, userId, who: speakerState.label ?? null },
      `${userId} reusing speaker state: ${speakerState.label ?? '(unlabeled)'}`,
    );
  }

  const speakerRuntime: SpeakerVoiceRuntime = {
    vad,
    opusStream,
    decoder,
    forceEndSpeech: () => {},
  };

  let sttStream: SttStream | null = null;
  const jobQueue: SpeakerJob[] = [];
  let draining = false;
  let decodedChunkCount = 0;
  let decodedBytes = 0;
  let lastDecodedAt: number | null = null;
  let audioWindowStartAt = Date.now();
  let audioWindowChunks = 0;
  let audioWindowBytes = 0;
  let audioWindowStats: PcmAudioStats = { sampleCount: 0, sumSquares: 0, peak: 0 };

  const logAudioDiagnostics = (reason: string, force = false) => {
    if (!AUDIO_DIAGNOSTICS_ENABLED) return;
    if (!force && Date.now() - audioWindowStartAt < AUDIO_DIAGNOSTICS_INTERVAL_MS) return;
    if (!force && audioWindowChunks === 0) return;

    const windowMs = Date.now() - audioWindowStartAt;
    const rms =
      audioWindowStats.sampleCount > 0 ? Math.sqrt(audioWindowStats.sumSquares / audioWindowStats.sampleCount) : 0;
    logger.info(
      {
        event: 'speaker_audio_diagnostics',
        guildId,
        userId,
        reason,
        decodedChunksTotal: decodedChunkCount,
        decodedBytesTotal: decodedBytes,
        lastDecodedAt,
        windowMs,
        windowChunks: audioWindowChunks,
        windowBytes: audioWindowBytes,
        rms: roundedLevel(rms),
        peak: roundedLevel(audioWindowStats.peak),
        sttStreamOpen: Boolean(sttStream),
        jobQueueLength: jobQueue.length,
      },
      `${userId} audio diagnostics: ${audioWindowChunks} PCM chunk(s), rms ${roundedLevel(rms)}, peak ${roundedLevel(audioWindowStats.peak)}`,
    );

    audioWindowStartAt = Date.now();
    audioWindowChunks = 0;
    audioWindowBytes = 0;
    audioWindowStats = { sampleCount: 0, sumSquares: 0, peak: 0 };
  };

  const observeDecodedPcmChunk = (chunk: Buffer) => {
    decodedChunkCount += 1;
    decodedBytes += chunk.length;
    lastDecodedAt = Date.now();
    audioWindowChunks += 1;
    audioWindowBytes += chunk.length;
    updatePcmAudioStats(audioWindowStats, chunk);
    logAudioDiagnostics('interval');
  };

  const closeSttStream = async (): Promise<TranscribeResult | null> => {
    const stream = sttStream;
    sttStream = null;
    if (!stream) return { text: '' };
    try {
      return await stream.close();
    } catch (err) {
      logger.error({ err, userId }, `Streamed STT failed for a segment from ${userId}`);
      return null;
    }
  };

  const handleDetectedSegment = (segment: Float32Array, sequence: number, transcribeResult: TranscribeResult | null) => {
    const durationSec = (segment.length / 16000).toFixed(2);
    logger.info({ userId, durationSec }, `${userId} VAD determined the sentence ended, audio duration ${durationSec}s`);

    saveInputRecording(userId, Date.now(), segment, 16000).catch((err) => {
      logger.error({ err, userId }, `Failed to save backup input recording for ${userId}`);
    });

    handleSegment(guildId, connection, voiceChannel, userId, segment, speakerState, sequence, transcribeResult).catch((err) => {
      logger.error({ err, userId, sequence }, `Failed to process a voice segment for ${userId}`);
    });
  };

  const drainJobQueue = async () => {
    if (draining) return;
    draining = true;

    while (jobQueue.length > 0) {
      const job = jobQueue.shift()!;
      try {
        if (job.type === 'chunk') {
          const sessionForStt = sttStream ? undefined : await getSession(guildId);
          const sttDecision = sessionForStt ? checkSttAllowed(sessionForStt) : undefined;
          const segments = await vad.feed(job.data, {
            onSpeechStart: () => {
              logger.info({ userId }, `${userId} VAD confirmed this is speech, starting to count a sentence`);
              if (!sttStream) {
                if (sttDecision && !sttDecision.allowed) {
                  logger.info(
                    { event: 'stt_blocked_by_billing', guildId, userId, reason: sttDecision.reason },
                    `${userId} blocked by billing before opening STT stream: ${sttDecision.reason}`,
                  );
                  void sendSttBlockedNotice(guildId, voiceChannel, sttDecision).catch((err) =>
                    logger.error({ err, guildId }, 'Failed to send STT-blocked notice'),
                  );
                  return;
                }
                const keyterms = getKeyterms(sessionForStt?.game, sessionForStt?.sourceLang);
                logger.info(
                  {
                    event: 'stt_stream_opening',
                    guildId,
                    userId,
                    who: speakerState.label ?? null,
                    sourceLang: sessionForStt?.sourceLang ?? null,
                    gameId: sessionForStt?.game ?? null,
                    keytermCount: keyterms.length,
                    hasLastTranscript: Boolean(speakerState.lastTranscript),
                  },
                  `${userId} opening STT stream for ${speakerState.label ?? 'unknown speaker'}`,
                );
                sttStream = openStream({
                  language: sessionForStt?.sourceLang,
                  prompt: speakerState.lastTranscript,
                  keyterms,
                });
              }
            },
          });
          sttStream?.pushChunk(job.data);
          for (const segment of segments) {
            const sequence = await nextPlaybackSequence(guildId);
            const transcribeResult = await closeSttStream();
            if (sequence === null) {
              logger.error({ userId }, `${userId} failed to allocate a playback sequence — guild session missing unexpectedly`);
              continue;
            }
            markMaking(guildId, connection, sequence);
            handleDetectedSegment(segment, sequence, transcribeResult);
          }
        } else if (job.type === 'forceEnd') {
          const segment = vad.forceEnd();
          if (segment) {
            logger.info({ userId }, `${userId} audio stream paused, force-ending this sentence`);
            const sequence = await nextPlaybackSequence(guildId);
            const transcribeResult = await closeSttStream();
            if (sequence === null) {
              logger.error({ userId }, `${userId} failed to allocate a playback sequence — guild session missing unexpectedly`);
            } else {
              markMaking(guildId, connection, sequence);
              handleDetectedSegment(segment, sequence, transcribeResult);
            }
          } else if (sttStream) {
            logger.info(
              {
                event: 'speaker_force_end_without_vad_segment',
                guildId,
                userId,
                decodedChunksTotal: decodedChunkCount,
                decodedBytesTotal: decodedBytes,
                lastDecodedAt,
                sttStreamOpen: true,
              },
              `${userId} speaking ended without a complete VAD segment, closing open STT stream`,
            );
            await closeSttStream();
          } else {
            logger.info(
              {
                event: 'speaker_force_end_without_vad_segment',
                guildId,
                userId,
                decodedChunksTotal: decodedChunkCount,
                decodedBytesTotal: decodedBytes,
                lastDecodedAt,
                sttStreamOpen: false,
              },
              `${userId} speaking ended before VAD confirmed speech`,
            );
          }
        }
      } catch (err) {
        logger.error({ err, userId }, `Failed to process an audio task for ${userId}`);
      }
    }

    draining = false;
  };

  decoder.on('data', (chunk: Buffer) => {
    observeDecodedPcmChunk(chunk);
    jobQueue.push({ type: 'chunk', data: chunk });
    drainJobQueue();
  });

  speakerRuntime.forceEndSpeech = () => {
    logAudioDiagnostics('speaking_end', true);
    jobQueue.push({ type: 'forceEnd' });
    drainJobQueue();
  };

  opusStream.on('error', (err) => logger.error({ err, userId }, `Opus stream error for ${userId}`));
  decoder.on('error', (err) => logger.error({ err, userId }, `Decoder stream error for ${userId}`));

  guildRuntime.speakers.set(userId, speakerRuntime);
  logger.info(
    { event: 'speaker_pipeline_started', guildId, userId, who: speakerState.label },
    `${userId} speaker pipeline ready as ${speakerState.label ?? 'unknown speaker'}`,
  );
}
