import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { languageGate, type LanguageConfig } from './languageGate.js';
import { ageDays, staleFlag } from './freshness.js';
import { assessLegitimacy, type Legitimacy } from './legitimacy.js';

export type Verdict = 'PASS' | 'FAIL' | 'FLAG';

export interface JobFacts { source?: string | null; url?: string | null; apply_url?: string | null; posted_at?: string | null; hard_stops?: string[]; repost_count?: number; snapshot_chars?: number; hard_stops_unreadable?: boolean }
/** `languagesInvalid` (with `languages: null`) = config file present but an entry is invalid; null alone = file missing. */
export interface VetoExtras { facts?: JobFacts; now?: Date; languages?: LanguageConfig | null; languagesInvalid?: string }
/** `gate_flags` (excluded jobs only): the soft flags computed anyway, persisted by saveGateResults while `flags` stays empty. */
export interface VetoResult { excluded: boolean; reason?: string; flags: string[]; gate_flags?: string[]; legitimacy?: Legitimacy; language_note?: string | null }

export function applyVetoes(
  m: { job_id: string; score: number; location_verdict?: Verdict; language_gate?: Verdict },
  job: { title: string; description: string },
  dealBreakers: string[],
  extras?: VetoExtras,
): VetoResult {
  const flags: string[] = [];
  const now = extras?.now ?? new Date();
  const ts = extras?.languages ? languageGate(job.description, extras.languages.declared, { confirmed: extras.languages.confirmed }) : null;
  // No facts at all (unknown job id, no db row): skip fact-based legitimacy so old-call-shape callers see no new noise.
  const hasFacts = !!extras?.facts && Object.keys(extras.facts).length > 0;
  const legit = extras && hasFacts ? assessLegitimacy({
    id: m.job_id, title: job.title, description: job.description, url: extras.facts?.url, apply_url: extras.facts?.apply_url,
    repost_count: extras.facts?.repost_count, age_days: ageDays(extras.facts?.posted_at, now),
    source: extras.facts?.source, snapshot_chars: extras.facts?.snapshot_chars,
  }) : undefined;
  const more = extras ? { legitimacy: legit, language_note: ts?.note ?? null } : {};
  // Soft flags are computed up front so an exclusion keeps them in gate_flags (the returned `flags` stay empty on exclusion).
  const soft: string[] = [];
  if (m.location_verdict === 'FLAG') soft.push('location FLAG');
  if (m.language_gate === 'FLAG' || ts?.verdict === 'FLAG') soft.push(ts?.verdict === 'FLAG' ? `language FLAG: ${ts.note}` : 'language FLAG');
  if (extras?.languages === null) soft.push(extras.languagesInvalid ? `language gate config invalid: ${extras.languagesInvalid}` : 'language gate config missing');
  const stale = extras ? staleFlag(extras.facts?.posted_at, now) : null;
  if (stale) soft.push(stale);
  if (legit?.tier === 'caution') for (const s of legit.signals.filter((x) => !x.startsWith('info:'))) soft.push(`legitimacy caution: ${s}`);
  const out = (r: Omit<VetoResult, 'legitimacy' | 'language_note'>): VetoResult =>
    ({ ...r, ...more, ...(extras && r.excluded ? { gate_flags: soft } : {}) });

  if (m.location_verdict === 'FAIL') return out({ excluded: true, reason: 'location FAIL', flags });
  if (m.language_gate === 'FAIL') return out({ excluded: true, reason: 'language FAIL', flags });
  if (ts?.verdict === 'FAIL') return out({ excluded: true, reason: `language FAIL: ${ts.note}`, flags });
  const hay = `${job.title}\n${job.description}`.toLowerCase();
  for (const raw of dealBreakers) {
    const kw = raw?.trim();
    if (kw && hay.includes(kw.toLowerCase())) return out({ excluded: true, reason: `deal-breaker: ${kw}`, flags });
  }
  if (extras?.facts?.hard_stops_unreadable) return out({ excluded: true, reason: 'gate data unreadable: hard_stops', flags });
  const stops = extras?.facts?.hard_stops ?? [];
  if (stops.length) return out({ excluded: true, reason: `hard stop: ${stops.join('; ')}`, flags });
  if (legit?.tier === 'suspicious') return out({ excluded: true, reason: `legitimacy: ${legit.signals.filter((s) => !s.startsWith('info:')).join('; ')}`, flags });

  return out({ excluded: false, flags: soft });
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
  ctx?: { facts?: Map<string, JobFacts>; now?: Date; languages?: LanguageConfig | null; languagesInvalid?: string },
): Array<{ job_id: string } & VetoResult> {
  const dealBreakers = (keywords ?? loadDealBreakers()).map((k) => k.trim()).filter(Boolean);
  const byId = new Map(jobs.map((j) => [j.id, { title: j.title, description: j.description ?? '' }]));
  return results.map((r) => {
    const job = byId.get(r.job_id) ?? { title: '', description: '' };
    const extras = ctx ? { facts: ctx.facts?.get(r.job_id), now: ctx.now, languages: ctx.languages, languagesInvalid: ctx.languagesInvalid } : undefined;
    return { job_id: r.job_id, ...applyVetoes(r, job, dealBreakers, extras) };
  });
}
