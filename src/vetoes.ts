import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { languageGate, type LanguageConfig } from './languageGate.js';
import { ageDays, staleFlag } from './freshness.js';
import { assessLegitimacy, type Legitimacy } from './legitimacy.js';

export type Verdict = 'PASS' | 'FAIL' | 'FLAG';

export interface JobFacts { source?: string | null; url?: string | null; apply_url?: string | null; posted_at?: string | null; hard_stops?: string[]; repost_count?: number; snapshot_chars?: number }
export interface VetoExtras { facts?: JobFacts; now?: Date; languages?: LanguageConfig | null }
export interface VetoResult { excluded: boolean; reason?: string; flags: string[]; legitimacy?: Legitimacy; language_note?: string | null }

export function applyVetoes(
  m: { job_id: string; score: number; location_verdict?: Verdict; language_gate?: Verdict },
  job: { title: string; description: string },
  dealBreakers: string[],
  extras?: VetoExtras,
): VetoResult {
  const flags: string[] = [];
  const now = extras?.now ?? new Date();
  const ts = extras?.languages ? languageGate(job.description, extras.languages.declared, { confirmed: extras.languages.confirmed }) : null;
  const legit = extras ? assessLegitimacy({
    id: m.job_id, title: job.title, description: job.description, url: extras.facts?.url, apply_url: extras.facts?.apply_url,
    repost_count: extras.facts?.repost_count, age_days: ageDays(extras.facts?.posted_at, now),
    source: extras.facts?.source, snapshot_chars: extras.facts?.snapshot_chars,
  }) : undefined;
  const more = extras ? { legitimacy: legit, language_note: ts?.note ?? null } : {};
  const out = (r: Omit<VetoResult, 'legitimacy' | 'language_note'>): VetoResult => ({ ...r, ...more });

  if (m.location_verdict === 'FAIL') return out({ excluded: true, reason: 'location FAIL', flags });
  if (m.language_gate === 'FAIL') return out({ excluded: true, reason: 'language FAIL', flags });
  if (ts?.verdict === 'FAIL') return out({ excluded: true, reason: `language FAIL: ${ts.note}`, flags });
  const hay = `${job.title}\n${job.description}`.toLowerCase();
  for (const raw of dealBreakers) {
    const kw = raw?.trim();
    if (kw && hay.includes(kw.toLowerCase())) return out({ excluded: true, reason: `deal-breaker: ${kw}`, flags });
  }
  const stops = extras?.facts?.hard_stops ?? [];
  if (stops.length) return out({ excluded: true, reason: `hard stop: ${stops.join('; ')}`, flags });
  if (legit?.tier === 'suspicious') return out({ excluded: true, reason: `legitimacy: ${legit.signals.filter((s) => !s.startsWith('info:')).join('; ')}`, flags });

  if (m.location_verdict === 'FLAG') flags.push('location FLAG');
  if (m.language_gate === 'FLAG' || ts?.verdict === 'FLAG') flags.push(ts?.verdict === 'FLAG' ? `language FLAG: ${ts.note}` : 'language FLAG');
  if (extras?.languages === null) flags.push('language gate config missing');
  const stale = extras ? staleFlag(extras.facts?.posted_at, now) : null;
  if (stale) flags.push(stale);
  if (legit?.tier === 'caution') for (const s of legit.signals.filter((x) => !x.startsWith('info:'))) flags.push(`legitimacy caution: ${s}`);
  return out({ excluded: false, flags });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dealBreakersPath = path.join(path.resolve(__dirname, '..'), 'config', 'deal-breakers.json');

/** Load trimmed, non-blank deal-breaker keywords; [] if the file is missing or unparsable. */
export function loadDealBreakers(file: string = dealBreakersPath): string[] {
  try {
    const kws: unknown = JSON.parse(readFileSync(file, 'utf8'))?.keywords;
    if (!Array.isArray(kws)) return [];
    return kws.filter((k): k is string => typeof k === 'string').map((k) => k.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Run applyVetoes per result. `keywords` overrides the config file (for tests). */
export function vetoResults(
  results: { job_id: string; score: number; location_verdict?: Verdict; language_gate?: Verdict }[],
  jobs: { id: string; title: string; description?: string | null }[],
  keywords?: string[],
  ctx?: { facts?: Map<string, JobFacts>; now?: Date; languages?: LanguageConfig | null },
): Array<{ job_id: string } & VetoResult> {
  const dealBreakers = (keywords ?? loadDealBreakers()).map((k) => k.trim()).filter(Boolean);
  const byId = new Map(jobs.map((j) => [j.id, { title: j.title, description: j.description ?? '' }]));
  return results.map((r) => {
    const job = byId.get(r.job_id) ?? { title: '', description: '' };
    const extras = ctx ? { facts: ctx.facts?.get(r.job_id), now: ctx.now, languages: ctx.languages } : undefined;
    return { job_id: r.job_id, ...applyVetoes(r, job, dealBreakers, extras) };
  });
}
