import type { VoiceConnection } from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import { ttsWavToDiscordPcm } from '../domain/wav.js';
import { estimateGender } from '../domain/pitch.js';
import { applyTerminology, stripKeepTags } from '../domain/terminology.js';
import { lookupTranslationCache } from './translate-cache-lookup.js';
import { saveOutputRecording } from '../adapter/out/recordings.js';
import { setCachedTranslation } from '../adapter/out/redis/translate-cache.js';
import type { TranscribeResult } from './ports/stt.js';
import { translate } from './ports/translate.js';
import { synthesize } from './ports/tts.js';
import { enqueuePlayback, skipPlaybackSequence, checkBacklogWarning, BACKLOG_WARNING_THRESHOLD } from '../adapter/out/playback-queue.js';
import { getSession, listSpeakerEntries, saveSpeaker, type SpeakerState } from './session.js';
import { assignVoice } from './voice-assignment.js';
import { checkTranslateAllowed, recordExternalApiUsage } from './billing/billing-service.js';
import { recordTranscriptEvent } from './transcripts/transcript-service.js';
import { createLogger } from '../adapter/out/logger.js';

const logger = createLogger('pipeline');

const TTS_VOICE_OVERRIDE = process.env.TTS_VOICE || undefined;

const CONFIG_NOT_SET_MESSAGE =
  "⚠️ I can't translate yet — set source and target language first with `/config source:<language> target:<language>`.";

async function sendConfigNotSetReminder(voiceChannel: VoiceBasedChannel): Promise<void> {
  await voiceChannel.send(CONFIG_NOT_SET_MESSAGE).catch((err: unknown) => logger.error({ err }, 'Failed to send config-not-set reminder'));
}

async function sendBillingBlockedReminder(voiceChannel: VoiceBasedChannel, message: string): Promise<void> {
  await voiceChannel.send(`⚠️ ${message}`).catch((err: unknown) => logger.error({ err }, 'Failed to send billing-blocked reminder'));
}

async function sendBillingWarningReminder(voiceChannel: VoiceBasedChannel, message: string): Promise<void> {
  await voiceChannel.send(`⚠️ ${message}`).catch((err: unknown) => logger.error({ err }, 'Failed to send billing-warning reminder'));
}

const BACKLOG_WARNING_MESSAGE =
  `🐢 Translation queue is backed up (more than ${BACKLOG_WARNING_THRESHOLD} lines waiting to play) — try speaking a little slower so translations can keep up.`;

async function sendBacklogWarningReminder(voiceChannel: VoiceBasedChannel): Promise<void> {
  await voiceChannel.send(BACKLOG_WARNING_MESSAGE).catch((err: unknown) => logger.error({ err }, 'Failed to send backlog-warning reminder'));
}

function detectSpeakerGender(speakerState: SpeakerState, monoFloat32: Float32Array): void {
  if (speakerState.gender) return;

  const { gender, medianHz } = estimateGender(monoFloat32);
  speakerState.gender = gender;

  const pitchInfo = medianHz ? `pitch≈${medianHz.toFixed(0)}Hz` : 'volume too low/short to judge, picked randomly';
  logger.info(
    { speaker: speakerState.label, gender, medianHz: medianHz ?? null },
    `${speakerState.label} spoke for the first time, gender=${gender} (${pitchInfo})`,
  );
}

async function resolveSpeakerVoice(guildId: string, userId: string, speakerState: SpeakerState, provider: string, lang: string): Promise<string> {
  if (speakerState.voice) return speakerState.voice;

  const usedVoices = new Set(
    (await listSpeakerEntries(guildId))
      .filter(([speakerUserId]) => speakerUserId !== userId)
      .map(([, speaker]) => speaker)
      .map((speaker) => speaker.voice)
      .filter((voice): voice is string => Boolean(voice)),
  );
  const voice = assignVoice(speakerState.gender ?? 'unknown', usedVoices, provider, lang);
  speakerState.voice = voice;
  await saveSpeaker(guildId, userId, speakerState);
  logger.info(
    { speaker: speakerState.label, provider, lang, voice },
    `${speakerState.label} first use of ${provider}(${lang}) for playback, assigned voice: ${voice}`,
  );
  return voice;
}

export async function handleSegment(
  guildId: string,
  connection: VoiceConnection,
  voiceChannel: VoiceBasedChannel,
  userId: string,
  monoFloat32: Float32Array,
  speakerState: SpeakerState,
  sequence: number,
  transcribeResult: TranscribeResult | null,
): Promise<void> {
  const t0 = Date.now();
  const elapsed = () => `${Date.now() - t0}ms`;
  const who = speakerState.label ?? userId;
  const ctx = { guildId, userId, sequence };

  let enqueued = false;
  try {
    if (checkBacklogWarning(guildId)) {
      logger.info({ ...ctx, who }, `${who} playback queue backlog exceeded threshold, sending slow-down reminder`);
      await sendBacklogWarningReminder(voiceChannel);
    }

    detectSpeakerGender(speakerState, monoFloat32);
    await saveSpeaker(guildId, userId, speakerState);

    if (!transcribeResult) {
      logger.info({ ...ctx, who }, `${who} streamed STT failed for this segment, skipping translate/playback`);
      return;
    }

    const session = await getSession(guildId);
    if (!session?.sourceLang || !session?.targetLang) {
      logger.info({ ...ctx, who }, `${who} source/target language not fully configured, skipping translate, sending text reminder`);
      await sendConfigNotSetReminder(voiceChannel);
      return;
    }

    const stamp = Date.now();
    logger.info({ ...ctx, who, sourceLang: session.sourceLang }, `${who} source language: ${session.sourceLang}`);

    const sourceLang = session.sourceLang;
    const targetLang = session.targetLang;
    const provider = session.ttsProvider;
    const baseTargetLang = targetLang;

    const result = transcribeResult;
    logger.debug({ ...ctx, who, elapsedMs: Date.now() - t0 }, `${who} [${elapsed()}] using streamed STT result`);
    const sttUsageLog = {
        event: 'external_api_usage',
        stage: 'stt',
        ...ctx,
        who,
        sourceLang: session.sourceLang,
        provider: result.usage?.provider,
        model: result.usage?.model,
        elapsedMs: result.usage?.elapsedMs,
        audioDurationSec: monoFloat32.length / 16000,
        providerAudioDurationSec: result.usage?.audioDurationSec,
        audioBytes: result.usage?.audioBytes,
        chunkCount: result.usage?.chunkCount,
        keytermCount: result.usage?.keytermCount,
      } as const;
    logger.debug(sttUsageLog, 'External API usage: STT transcription');
    await recordExternalApiUsage(sttUsageLog);

    const transcriptText = result.text?.trim();
    if (!transcriptText) {
      logger.debug({ ...ctx, who }, `${who} no text recognized from this segment, skipping`);
      return;
    }

    const billingDecision = await checkTranslateAllowed(guildId, session, transcriptText.length);
    if (!billingDecision.allowed) {
      logger.info(
        { ...ctx, who, planId: billingDecision.planId, reason: billingDecision.reason },
        `${who} billing limit blocked translation: ${billingDecision.reason}`,
      );
      if (billingDecision.userMessage) {
        await sendBillingBlockedReminder(voiceChannel, billingDecision.userMessage);
      }
      return;
    }
    if (billingDecision.warningMessage) {
      await sendBillingWarningReminder(voiceChannel, billingDecision.warningMessage);
    }

    logger.info({ event: 'translation_cache_candidate', ...ctx, who, transcript: transcriptText }, `${who} transcript: "${transcriptText}"`);
    speakerState.lastTranscript = transcriptText;
    await saveSpeaker(guildId, userId, speakerState);

    const cacheLookup = await lookupTranslationCache({
      sourceLang: session.sourceLang,
      targetLang,
      gameId: session.game,
      transcriptText,
    });
    logger.debug(
      {
        event: 'translation_cache_lookup',
        ...ctx,
        who,
        sourceLang: session.sourceLang,
        targetLang,
        gameId: session.game ?? null,
        cacheResult: cacheLookup.kind,
        cacheKey: 'cacheKey' in cacheLookup ? cacheLookup.cacheKey : undefined,
        transcriptTextChars: transcriptText.length,
        normalizedTextChars: 'normalizedText' in cacheLookup ? cacheLookup.normalizedText.length : undefined,
        cachedTranslationChars: cacheLookup.kind === 'hit' ? cacheLookup.translatedText.length : undefined,
      },
      'Translation cache lookup',
    );

    if (cacheLookup.kind === 'empty-after-normalize') {
      logger.info({ ...ctx, who }, `${who} normalized to empty (pure filler words), skipping translate/playback`);
      return;
    }

    let textForTranslation = transcriptText;
    let cacheKey: string | undefined;
    let translatedText: string | undefined;
    let hitCount = 0;

    if (cacheLookup.kind === 'hit') {
      cacheKey = cacheLookup.cacheKey;
      translatedText = cacheLookup.translatedText;
      logger.info(
        {
          event: 'translation_cache_hit',
          guildId,
          sequence,
        },
        'Translation cache hit',
      );
    } else if (cacheLookup.kind === 'miss') {
      textForTranslation = cacheLookup.textForTranslation;
      cacheKey = cacheLookup.cacheKey;
    }

    if (translatedText === undefined) {
      const applied = applyTerminology(textForTranslation, session.sourceLang, baseTargetLang, session?.game);
      const preparedText = applied.text;
      hitCount = applied.hitCount;
      if (hitCount > 0) {
        logger.info({ ...ctx, who, hitCount, preparedText }, `${who} matched ${hitCount} term(s), sending to translation after preprocessing: "${preparedText}"`);
      }

      const rawTranslatedText = await translate(preparedText, targetLang, {
        logContext: { ...ctx, who, sourceLang: session.sourceLang, targetLang },
      });
      logger.debug({ ...ctx, who, elapsedMs: Date.now() - t0 }, `${who} [${elapsed()}] translation returned`);
      if (hitCount > 0) {
        logger.info({ ...ctx, who, rawTranslatedText }, `${who} raw translation output (for verification, includes <keep> tags): "${rawTranslatedText}"`);
      }
      translatedText = stripKeepTags(rawTranslatedText);
      logger.info({ ...ctx, who, targetLang, translatedText }, `${who} translation (${targetLang}): "${translatedText}"`);

      if (cacheKey && translatedText) {
        setCachedTranslation(cacheKey, translatedText);
      }
    }

    if (!translatedText) {
      logger.info({ ...ctx, who }, `${who} translation result is empty, skipping playback`);
      return;
    }

    // 要不要写 transcript_events 只看这个缓存的布尔标志（/join 时从
    // guilds.transcript_retention_enabled 快照进 session，见 trans-sessions.ts），
    // 不看 session.transSessionId 是否存在——那一行现在无条件被创建（billing 结算
    // 需要），不能再当"这个 guild 开没开对话素材留存"的信号。
    const transSessionId = session.transSessionId;
    if (session.transcriptRetentionEnabled && transSessionId) {
      recordTranscriptEvent({
        guildId,
        sessionId: transSessionId,
        userId,
        sequence,
        gameId: session.game,
        sourceLang,
        targetLang,
        transcriptText,
        translatedText,
        termHitCount: hitCount,
        cacheHit: cacheLookup.kind === 'hit',
      }).catch((err) => logger.error({ err, ...ctx, who }, `${who} failed to record transcript event`));
    }

    if (!provider) {
      logger.info(
        { ...ctx, who, targetLang },
        `${who} target language "${targetLang}" has no corresponding TTS provider, translated text only, no voice playback`,
      );
      return;
    }

    const voice = TTS_VOICE_OVERRIDE ?? (await resolveSpeakerVoice(guildId, userId, speakerState, provider, baseTargetLang));
    const ttsWav = await synthesize(translatedText, {
      voice,
      targetLang,
      provider,
      logContext: { ...ctx, who, sourceLang: session.sourceLang, targetLang },
    });
    logger.debug(
      { ...ctx, who, elapsedMs: Date.now() - t0, provider, voice },
      `${who} [${elapsed()}] TTS returned (provider: ${provider}, voice: ${voice}), entering playback queue`,
    );
    saveOutputRecording(userId, stamp, ttsWav).catch((err) => logger.error({ err, userId, stamp }, 'Failed to save output recording'));

    const pcm = ttsWavToDiscordPcm(ttsWav);
    enqueuePlayback(guildId, connection, pcm, sequence);
    enqueued = true;
  } finally {
    if (!enqueued) skipPlaybackSequence(guildId, connection, sequence);
  }
}
