import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import OpenCC from 'opencc-js';
import { GAMES } from './games.js';
import { toBaseLang } from './language.js';

const toTraditional = OpenCC.Converter({ from: 'cn', to: 'tw' });

interface TermValue {
  translations: Record<string, string | string[] | undefined>;
}

interface AutomatonEntry {
  regex: RegExp;
  lookup: Map<string, TermValue>;
}

export interface ApplyTerminologyResult {
  text: string;
  hitCount: number;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadDictionaries(): Map<string, TermValue[]> {
  const byGame = new Map<string, TermValue[]>();
  for (const game of GAMES) {
    const filePath = path.join(__dirname, `terminology/${game.id}.json`);
    if (!existsSync(filePath)) {
      throw new Error(`games.js declares game "${game.id}" but its dictionary file is missing: ${filePath}`);
    }
    byGame.set(game.id, JSON.parse(readFileSync(filePath, 'utf-8')));
  }
  return byGame;
}

const NO_WORD_BOUNDARY_LANGS = new Set(['zh', 'ja', 'ko', 'ar']);

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function surfaceForms(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

function canonicalForm(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function buildAutomatons(dictionariesByGame: Map<string, TermValue[]>): Map<string, Map<string, AutomatonEntry>> {
  const result = new Map<string, Map<string, AutomatonEntry>>();
  for (const [game, entries] of dictionariesByGame) {
    const byLang = new Map<string, { surface: string; entry: TermValue }[]>();
    for (const entry of entries) {
      for (const [lang, value] of Object.entries(entry.translations)) {
        if (!value) continue;
        if (!byLang.has(lang)) byLang.set(lang, []);
        for (const surface of surfaceForms(value)) {
          byLang.get(lang)!.push({ surface, entry });
        }
      }
    }

    const langMap = new Map<string, AutomatonEntry>();
    for (const [lang, items] of byLang) {
      const sorted = [...items].sort((a, b) => b.surface.length - a.surface.length);
      const alternation = sorted.map((item) => escapeRegex(item.surface)).join('|');
      const boundary = NO_WORD_BOUNDARY_LANGS.has(lang) ? '' : '\\b';
      const regex = new RegExp(`${boundary}(?:${alternation})${boundary}`, 'gi');
      const lookup = new Map(sorted.map((item) => [item.surface.toLowerCase(), item.entry]));
      langMap.set(lang, { regex, lookup });
    }
    result.set(game, langMap);
  }
  return result;
}

const automatons = buildAutomatons(loadDictionaries());

export function applyTerminology(
  text: string,
  sourceLang: string | undefined,
  targetLang: string | undefined,
  game: string | undefined,
): ApplyTerminologyResult {
  if (!text || !sourceLang || !game) return { text, hitCount: 0 };

  const baseSourceLang = toBaseLang(sourceLang);
  const automaton = automatons.get(game)?.get(baseSourceLang!);
  if (!automaton) return { text, hitCount: 0 };

  if (baseSourceLang === 'zh') text = toTraditional(text);

  const { regex, lookup } = automaton;
  regex.lastIndex = 0;

  let hitCount = 0;
  let out = '';
  let lastEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    const matched = match[0];
    const entry = lookup.get(matched.toLowerCase());
    const targetWord =
      baseSourceLang === targetLang || !targetLang ? undefined : canonicalForm(entry?.translations?.[targetLang]);

    out += text.slice(lastEnd, match.index);
    if (targetWord) {
      out += `<keep>${targetWord}</keep>`;
      hitCount += 1;
    } else {
      out += matched;
    }
    lastEnd = match.index + matched.length;
  }
  out += text.slice(lastEnd);

  return { text: out, hitCount };
}

export function stripKeepTags(text: string): string {
  return text.replace(/<\/?keep>/g, '');
}
