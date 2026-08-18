# DESIGN.md

## Requirement Summary

Add a Redis caching layer so that repeated/high-frequency short lines skip the LLM translation call and return the cached translation directly, before hitting the translation step in the pipeline.

## Design

Insert a cache lookup/write step between STT and LLM translation.

**Scope**: This ticket covers Chinese (zh) source language only. Non-Chinese source languages (en/ko/ar) are not wired into the caching logic at all — they go straight to the existing LLM translation flow, as if the cache step didn't exist. Extending caching to other source languages is left to a future ticket.

**Normalization** (Chinese text only, applied before translation and before the cache lookup, in a fixed order):
1. Punctuation handling: convert fullwidth punctuation to halfwidth, collapse consecutive repeated punctuation into a single occurrence; punctuation in the middle of a sentence is left untouched to avoid breaking grammatical structure
2. Filler-particle stripping: only match at the start/end of the sentence (not a full-sentence scan-and-replace), using a whitelist (啊、呀、嘛、呢、哦、噢、诶、哈、嘞、咯、哇), extendable during the beta period; words like "吧"/"了" that can affect tone strength or tense/completion are not stripped
3. Repetition/stutter noise compression: collapse the same character/word repeated 2+ times in a row down to one occurrence
4. Whitespace normalization: collapse multiple spaces, trim leading/trailing whitespace, handle abnormal inter-word spacing

If normalization reduces the text to an empty string (pure filler words), skip the cache lookup and the LLM translation entirely — no output, no cache write.

**No fuzzy matching**: only rule-based normalization + exact match. No SimHash/MinHash/edit-distance or other similarity algorithms — in short game-chat lines the distinguishing information is often at the end of the sentence, and similarity algorithms risk conflating semantically different lines as similar.

**Cache key**: `"translate:" + SHA-256(game_id + ":" + src_lang + ":" + tgt_lang + ":" + normalized_text)`, with `src_lang` fixed to `zh`; hashing uses SHA-256 (not a language's built-in non-persistent hash function); keys are namespaced under the `translate:` prefix.

**Cache lifetime**: writes are set with a TTL of 3 days and expire automatically. No manual/event-driven invalidation (e.g. a terminology dictionary update does not proactively invalidate related cache entries) — a translation staying slightly stale for up to 3 days after a dictionary change is an accepted tradeoff for this ticket.

**Redis unavailable fallback behavior**: if a Redis lookup or write errors or times out, log the error and skip the cache step, proceeding straight to the normal LLM translation flow — effectively as if the cache layer weren't involved for that sentence. No blocking, no retry, no impact on the availability of the core pipeline, consistent with the project's general principle that an auxiliary feature failing must not take down the core flow.
