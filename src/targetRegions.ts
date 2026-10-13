// Target regions for the location gate (config/target-regions.json). The match-jobs skill judges location with the regions the caller passes;
// this module is the deterministic backstop used by applyVetoes: a matcher FAIL for a posting that names a target region becomes a visible FLAG,
// never a silent pass and never an exclusion on location grounds alone. Missing file = the built-in defaults; an invalid file = null (callers flag it).
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TargetRegions {
  /** Regions where the candidate lives (on-site there passes): India. */
  home: string[];
  /** Regions the candidate would relocate to or already can work in: on-site there is a FLAG (visa, residency, relocation), not a FAIL. */
  targets: string[];
  /** Remote roles that accept the candidate are acceptable. */
  remote: boolean;
}

export const GULF_TERMS = [
  'United Arab Emirates', 'UAE', 'Dubai', 'Abu Dhabi', 'Sharjah', 'Saudi Arabia', 'KSA', 'Riyadh', 'Jeddah', 'Qatar', 'Doha',
  'Kuwait', 'Bahrain', 'Oman', 'Muscat', 'GCC', 'Middle East', 'MENA',
];
export const DEFAULT_TARGET_REGIONS: TargetRegions = { home: ['India'], targets: GULF_TERMS, remote: true };

const defaultPath = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'config', 'target-regions.json');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const terms = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() && x.length <= 60) && v.length <= 100 ? (v as string[]).map((x) => x.trim()) : null;

export function loadTargetRegionsStatus(file: string = defaultPath): { config: TargetRegions | null; invalid?: string } {
  if (!existsSync(file)) return { config: DEFAULT_TARGET_REGIONS };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const home = terms(raw?.home);
    const targets = terms(raw?.targets);
    if (!home || !home.length) return { config: null, invalid: 'home must be a non-empty array of short strings' };
    if (!targets) return { config: null, invalid: 'targets must be an array of at most 100 short strings' };
    if (raw.remote !== undefined && typeof raw.remote !== 'boolean') return { config: null, invalid: 'remote must be true or false' };
    return { config: { home, targets, remote: raw.remote !== false } };
  } catch (e: any) {
    return { config: null, invalid: String(e?.message ?? e).slice(0, 120) };
  }
}

/** First target region named in the text (whole words, case-insensitive, so "Doha" never matches inside another word), else null. */
export function mentionedTargetRegion(text: string, targets: string[]): string | null {
  const hay = String(text ?? '').toLowerCase();
  for (const t of targets) {
    const term = t.trim().toLowerCase();
    if (term && new RegExp(`(?<![a-z0-9])${esc(term)}(?![a-z0-9])`).test(hay)) return t;
  }
  return null;
}
