// file: src/languageGate.ts
// Adapted from MadsLorentzen/ai-job-search 04-job-evaluation.md "Language Gate" (MIT, (c) 2026 Mads Lorentzen). See that repo's LICENSE.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { htmlToLines } from './htmlText.js';
import { LANGUAGES } from './languages.js';

export type LangLevel = 'basic' | 'professional' | 'fluent' | 'native';
export interface DeclaredLanguage { language: string; level: LangLevel }
export interface LanguageConfig { declared: DeclaredLanguage[]; confirmed: boolean }
export interface LanguageRequirement { language: string; level: LangLevel; preferred: boolean; quote: string }
type Verdict = 'PASS' | 'FAIL' | 'FLAG';

const LANG_SET = new Set(LANGUAGES);
// A language name only counts when one of these words sits right next to it (skipping joiners and other language names).
// This is what separates "Fluent German is required" from "German customers must be served".
const CONTEXT = new Set(['fluent', 'fluency', 'native', 'proficient', 'proficiency', 'bilingual', 'multilingual', 'conversational',
  'speak', 'speaks', 'speaking', 'speaker', 'speakers', 'written', 'spoken', 'verbal', 'knowledge', 'command', 'language', 'languages',
  'level', 'skills', 'communication', 'c1', 'c2', 'b2', 'required', 'mandatory', 'essential', 'needed', 'necessary',
  'plus', 'bonus', 'advantage', 'advantageous', 'preferred', 'desirable']);
const JOINERS = new Set(['and', 'or', 'in', 'of', 'with', 'the', 'a', 'an', 'is', 'are', 'be', 'to', 'for', 'as', 'strong', 'big', 'real', 'definite', 'great', 'nice', 'huge']);
// "Hindi speaking customers" describes the audience, not a requirement on the candidate.
const AUDIENCE = new Set(['customer', 'customers', 'client', 'clients', 'user', 'users', 'market', 'markets', 'country', 'countries',
  'region', 'regions', 'population', 'audience', 'community', 'communities', 'team', 'teams', 'colleagues', 'candidates', 'candidate',
  'people', 'stakeholders', 'partners', 'area', 'areas', 'territory', 'territories', 'businesses', 'world']);
const PREFERRED_CUE = /\b(?:nice to have|a plus|plus|bonus|preferred|advantage|advantageous|desirable|ideally)\b/i;
const RANK: Record<LangLevel, number> = { basic: 0, professional: 1, fluent: 2, native: 3 };
const ORDER: Verdict[] = ['PASS', 'FLAG', 'FAIL'];
const MAX_QUOTE = 200;
const MAX_SKIPS = 6;

function levelOf(sentence: string): LangLevel {
  if (/\b(?:native|mother tongue|c2)\b/i.test(sentence)) return 'native';
  if (/\b(?:fluent|fluency|excellent|business[\s-]level|c1|advanced)\b/i.test(sentence)) return 'fluent';
  if (/\b(?:basic|conversational|a2|b1)\b/i.test(sentence)) return 'basic';
  return 'fluent';
}

function sentences(text: string): string[] {
  return String(text ?? '').split(/\n+|(?<=[.!?;])\s+|\s*[•·]\s*/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** True when a context word is right next to token i in direction dir (+1 after, -1 before). */
function contextNear(tokens: string[], i: number, dir: 1 | -1): boolean {
  let skips = 0;
  for (let j = i + dir; j >= 0 && j < tokens.length && skips <= MAX_SKIPS; j += dir, skips++) {
    const raw = tokens[j];
    const w = raw.toLowerCase();
    if (LANG_SET.has(raw) || JOINERS.has(w)) continue;
    if (dir === 1 && (w === 'speaking' || w === 'speaker' || w === 'speakers') && AUDIENCE.has((tokens[j + 1] ?? '').toLowerCase())) return false;
    return CONTEXT.has(w);
  }
  return false;
}

/** HTML is stripped first; only language names with language-context wording next to them count. */
export function detectLanguageRequirements(jd: string): LanguageRequirement[] {
  const out: LanguageRequirement[] = [];
  for (const s of sentences(htmlToLines(jd))) {
    const tokens = s.match(/[A-Za-z0-9]+/g) ?? [];
    const found = new Set<string>();
    tokens.forEach((t, i) => { if (LANG_SET.has(t) && (contextNear(tokens, i, -1) || contextNear(tokens, i, 1))) found.add(t); });
    if (!found.size) continue;
    const quote = s.length > MAX_QUOTE ? `${s.slice(0, MAX_QUOTE - 3)}...` : s;
    const preferred = PREFERRED_CUE.test(s) && !/\b(?:required|mandatory|must|essential)\b/i.test(s);
    for (const language of found) out.push({ language, level: levelOf(s), preferred, quote });
  }
  return out;
}

export function languageGate(
  jd: string,
  declared: DeclaredLanguage[],
  opts: { confirmed?: boolean } = {},
): { verdict: Verdict; note: string | null } {
  const confirmed = opts.confirmed ?? true;
  const have = new Map(declared.map((d) => [d.language.toLowerCase(), d.level]));
  let verdict: Verdict = 'PASS';
  let note: string | null = null;
  for (const r of detectLanguageRequirements(jd)) {
    const mine = have.get(r.language.toLowerCase());
    let v: Verdict = 'PASS';
    let n: string | null = null;
    if (mine == null) {
      v = r.preferred ? 'FLAG' : 'FAIL';
      n = `${r.preferred ? 'prefers' : 'requires'} ${r.language} (${r.level}): "${r.quote}"`;
      // Until the user confirms config/languages.json the declared list is a guess: never exclude on it.
      if (v === 'FAIL' && !confirmed) { v = 'FLAG'; n = `unconfirmed languages.json: ${n}`; }
    } else if (RANK[mine] < RANK[r.level]) {
      v = 'FLAG';
      n = `asks ${r.language} (${r.level}), declared ${mine}: "${r.quote}"`;
    }
    if (ORDER.indexOf(v) > ORDER.indexOf(verdict)) { verdict = v; note = n; }
  }
  return { verdict, note };
}

const defaultPath = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'config', 'languages.json');

/** null = missing, unreadable or empty: callers must surface a "language gate config missing" flag rather than skip silently. */
export function loadLanguageConfig(file: string = defaultPath): LanguageConfig | null {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(j?.declared)) return null;
    const declared = j.declared.filter((d: any) => typeof d?.language === 'string' && d.language.trim() && d.level in RANK)
      .map((d: any) => ({ language: d.language.trim(), level: d.level as LangLevel }));
    return declared.length ? { declared, confirmed: j.confirmed === true } : null;
  } catch {
    return null;
  }
}
