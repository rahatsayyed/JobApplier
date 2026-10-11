// file: src/score.ts
// Matcher-row validation and invariants. Requirement table adapted from career-ops-hq/career-ops modes/_shared.md
// Block B (MIT, (c) 2026 Santiago Fernandez de Valderrama); write invariants adapted from MadsLorentzen/ai-job-search
// tools/rank_state.py (MIT, (c) 2026 Mads Lorentzen). See those repos' LICENSE files.
import type { MatchResultInput } from './db.js';
import { htmlToText } from './htmlText.js';
import { LANGUAGES } from './languages.js';

export type Importance = 'critical' | 'high' | 'meaningful' | 'preferred' | 'low_signal';
export type Evidence = 'stated' | 'structural' | 'inferred';
export type ReqMatch = 'strong' | 'partial' | 'missing';
export type ReqCategory = 'skill' | 'experience' | 'education' | 'location' | 'language' | 'other';
export interface Requirement { req: string; importance: Importance; evidence: Evidence; jd_quote: string | null; match: ReqMatch; category?: ReqCategory }
export interface ScoreDims { skills: number; seniority: number; domain: number; location: number }
export interface MatchRowInput extends MatchResultInput {
  score_dims?: ScoreDims;
  requirements?: Requirement[];
  strengths?: string[];
  gaps?: string[];
  deadline?: string | null;
  language_note?: string;
  error?: string;
}
export interface NormalizedMatch extends MatchResultInput {
  score_dims: ScoreDims | null;
  requirements: Requirement[];
  strengths: string[];
  gaps: string[];
  hard_stops: string[];
  confidence: 'high' | 'medium' | 'low';
  deadline: string | null | undefined;
  language_note: string | null;
}

const IMPORTANCE: Importance[] = ['critical', 'high', 'meaningful', 'preferred', 'low_signal'];
const EVIDENCE: Evidence[] = ['stated', 'structural', 'inferred'];
const MATCHES: ReqMatch[] = ['missing', 'partial', 'strong'];
const CATEGORIES: ReqCategory[] = ['skill', 'experience', 'education', 'location', 'language', 'other'];
const VERDICTS = ['PASS', 'FAIL', 'FLAG'] as const;
const DIMS: Array<keyof ScoreDims> = ['skills', 'seniority', 'domain', 'location'];
const MAX_ROWS = 12;

const fold = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

export function normalizeRequirements(reqs: unknown, description?: string): Requirement[] {
  if (!Array.isArray(reqs)) return [];
  // The model quotes what it read, which may be raw HTML (remotive/remoteok) or page text: accept a quote found in either form.
  const jd = description ? `${fold(description)} ${fold(htmlToText(description))}` : null;
  const out: Requirement[] = [];
  for (const r of reqs as any[]) {
    if (!r || typeof r.req !== 'string' || !r.req.trim()) continue;
    let evidence: Evidence = EVIDENCE.includes(r.evidence) ? r.evidence : 'inferred';
    let importance: Importance = IMPORTANCE.includes(r.importance) ? r.importance : 'meaningful';
    const jd_quote = typeof r.jd_quote === 'string' && r.jd_quote.trim() ? r.jd_quote.trim() : null;
    // "stated" means quoted from the posting: no quote, or a quote not in the posting, is at best structural.
    if (evidence === 'stated' && (!jd_quote || (jd != null && !jd.includes(fold(jd_quote))))) evidence = 'structural';
    // Gate: inferred evidence can never be critical or high.
    if (evidence === 'inferred' && (importance === 'critical' || importance === 'high')) importance = 'meaningful';
    out.push({
      req: r.req.trim(), importance, evidence, jd_quote, match: MATCHES.includes(r.match) ? r.match : 'missing',
      ...(CATEGORIES.includes(r.category) ? { category: r.category as ReqCategory } : {}),
    });
  }
  out.sort((a, b) => IMPORTANCE.indexOf(a.importance) - IMPORTANCE.indexOf(b.importance) || MATCHES.indexOf(a.match) - MATCHES.indexOf(b.match));
  return out.filter((r, i) => i < MAX_ROWS || r.importance === 'critical' || r.importance === 'high');
}

// Location and language conditions belong to the dedicated gates (location_verdict, the language gate), never to hard stops.
// The matcher sets `category`; the wording check is the backstop when it forgets.
const LOCATION_OR_LANGUAGE_RE = new RegExp(
  `\\b(?:on-?site|onsite|hybrid|remote|relocat\\w*|locat(?:ion|ed)|based in|reside\\w*|time ?zone|visa|work (?:permit|authori[sz]ation)|right to work|fluent|fluency|bilingual|native speaker|language|${LANGUAGES.join('|')})\\b`, 'i');
const isLocationOrLanguage = (r: Requirement) => r.category === 'location' || r.category === 'language' || LOCATION_OR_LANGUAGE_RE.test(r.req);

/** Hard stop = an explicit non-negotiable the candidate does not meet: critical + missing, stated or structural evidence, and not a location/language row. */
export function hardStops(reqs: Requirement[]): string[] {
  return reqs.filter((r) => r.importance === 'critical' && r.match === 'missing' && r.evidence !== 'inferred' && !isLocationOrLanguage(r)).map((r) => r.req);
}

function confidenceOf(reqs: Requirement[], description?: string): 'high' | 'medium' | 'low' {
  if (!reqs.length || (description != null && htmlToText(description).length < 300)) return 'low';
  return reqs.some((r) => r.evidence === 'inferred') ? 'medium' : 'high';
}

const cap3 = (xs: unknown): string[] =>
  (Array.isArray(xs) ? xs : []).filter((s): s is string => typeof s === 'string' && !!s.trim()).map((s) => s.trim()).slice(0, 3);

export function normalizeMatchRow(r: MatchRowInput, description?: string): { ok: true; row: NormalizedMatch } | { ok: false; error: string } {
  let score: number;
  let dims: ScoreDims | null = null;
  if (r.score_dims != null) {
    for (const k of DIMS) {
      const v = (r.score_dims as any)[k];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 25) return { ok: false, error: `invalid score_dims.${k}: ${String(v)}` };
    }
    dims = { skills: r.score_dims.skills, seniority: r.score_dims.seniority, domain: r.score_dims.domain, location: r.score_dims.location };
    score = dims.skills + dims.seniority + dims.domain + dims.location;
  } else {
    if (typeof r.score !== 'number' || !Number.isFinite(r.score) || r.score < 0 || r.score > 100) return { ok: false, error: `invalid score: ${String(r.score)}` };
    score = Math.round(r.score);
  }
  const requirements = normalizeRequirements(r.requirements, description);
  // Loosely typed fields are sanitized here, never allowed to fail the call: only the score/dims decide rejection.
  const verdict = (v: unknown) => ((VERDICTS as readonly unknown[]).includes(v) ? (v as 'PASS' | 'FAIL' | 'FLAG') : undefined);
  return {
    ok: true,
    row: {
      ...r,
      reasons: typeof r.reasons === 'string' ? r.reasons : '',
      missing_keywords: Array.isArray(r.missing_keywords) ? r.missing_keywords.filter((k): k is string => typeof k === 'string') : [],
      location_verdict: verdict(r.location_verdict),
      language_gate: verdict(r.language_gate),
      score,
      score_dims: dims,
      requirements,
      strengths: cap3(r.strengths),
      gaps: cap3(r.gaps),
      hard_stops: hardStops(requirements),
      confidence: confidenceOf(requirements, description),
      deadline: r.deadline === undefined ? undefined : typeof r.deadline === 'string' && r.deadline.trim() ? r.deadline.trim() : null,
      language_note: typeof r.language_note === 'string' && r.language_note.trim() ? r.language_note.trim() : null,
    },
  };
}
