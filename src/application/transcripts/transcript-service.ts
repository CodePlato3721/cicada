// 对话素材（transcript_events）的写入。跟 billing/ 分开成独立模块——这是"给以后
// discovery agent 用的语料留存"，跟计费逻辑是两个关注点,不应该混进 billing-service.ts
// （billing 这个名字继续只表示真正的计费逻辑）。trans_sessions 这一行本身的生命周期
// （open/update/finalize）不在这个文件——见 ../trans-sessions.ts 和
// billing/billing-service.ts 的 finalizeSessionLedger，这两处都跟计费共用同一行,
// 这个文件只管往 transcript_events 插数据。
import { dbPool } from '../../adapter/out/db/client.js';

export interface TranscriptEventInput {
  guildId: string;
  sessionId: string;
  userId: string;
  sequence: number;
  gameId: string | undefined;
  sourceLang: string;
  targetLang: string;
  transcriptText: string;
  translatedText: string;
  termHitCount: number;
  cacheHit: boolean;
}

// pipeline.ts 里发射后不管地调用（跟 saveOutputRecording 同样的模式）——语料留存
// 失败不该拖垮翻译主流程,失败只记日志。调用方（pipeline.ts）负责先判断
// session.transcriptRetentionEnabled 再决定要不要调用这个函数,这里不重复判断。
export async function recordTranscriptEvent(input: TranscriptEventInput): Promise<void> {
  await dbPool.query(
    `
      insert into transcript_events (
        session_id, guild_id, user_id, sequence, game_id, source_lang, target_lang,
        transcript_text, translated_text, term_hit_count, cache_hit
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `,
    [
      input.sessionId,
      input.guildId,
      input.userId,
      input.sequence,
      input.gameId ?? null,
      input.sourceLang,
      input.targetLang,
      input.transcriptText,
      input.translatedText,
      input.termHitCount,
      input.cacheHit,
    ],
  );
}
