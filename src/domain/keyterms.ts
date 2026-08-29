import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { GAMES } from './games.js';
import { toBaseLang } from './language.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type KeytermsByLang = Record<string, string[] | undefined>;

function loadKeytermFiles(): Map<string, KeytermsByLang> {
  const byGame = new Map<string, KeytermsByLang>();
  for (const game of GAMES) {
    const filePath = path.join(__dirname, `keyterms/${game.id}.json`);
    if (!existsSync(filePath)) {
      throw new Error(`games.js declares game "${game.id}" but its keyterm file is missing: ${filePath}`);
    }
    byGame.set(game.id, JSON.parse(readFileSync(filePath, 'utf-8')));
  }
  return byGame;
}

const KEYTERMS_BY_GAME = loadKeytermFiles();

const DEFAULT_KEYTERM_LIMIT = Number(process.env.STT_KEYTERM_LIMIT) || 50;

export function getKeyterms(gameId: string | undefined, lang: string | undefined, limit: number = DEFAULT_KEYTERM_LIMIT): string[] {
  const baseLang = toBaseLang(lang);
  if (!gameId || !baseLang) return [];

  const byLang = KEYTERMS_BY_GAME.get(gameId);
  const terms = byLang?.[baseLang] ?? (baseLang === 'en' ? undefined : byLang?.en);
  if (!terms) return [];
  return terms.slice(0, limit);
}
