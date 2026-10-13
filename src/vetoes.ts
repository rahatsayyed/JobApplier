import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { languageGate, type LanguageConfig } from './languageGate.js';
import { ageDays, deadlinePassed, staleFlag } from './freshness.js';
import { assessLegitimacy, type Legitimacy } from './legitimacy.js';
import { specificTargets, targetRegionEvidence, type TargetRegions } from './targetRegions.js';
import { findRestriction } from './remotePolicy.js';

/** The target term that justifies turning a model location FAIL into a FLAG, or null (FAIL stays): no restriction marker, and real evidence (see targetRegionEvidence). */
function regionDowngrade(job: { title: string; description: string; location?: string | null }, targets: string[]): string | null {
  const specific = specificTargets(targets);
  const restricted = findRestriction(String(job.location ?? ''), { scope: 'location', targets: specific })
    ?? findRestriction(`${job.title}\n${job.description}`, { scope: 'posting', targets: specific });
  return restricted ? null : targetRegionEvidence(job, targets);
}

export type Verdict = 'PASS' | 'FAIL' | 'FLAG';

export interface JobFacts { source?: string | null; url?: string | null; apply_url?: string | null; posted_at?: string | null; deadline?: string | null; acted?: boolean; overridden?: boolean; hard_stops?: string[]; repost_count?: number; snapshot_chars?: number; hard_stops_unreadable?: boolean }
/** `languagesInvalid` (with `languages: null`) = config file present but an entry is invalid; null alone = file missing. */
export interface VetoExtras {
  facts?: JobFacts; now?: Date; languages?: LanguageConfig | null; languagesInvalid?: string;
  // Target regions (config/target-regions.json). undefined = caller does not use them; null (+ targetRegionsInvalid) = the file is invalid: no downgrade, a flag.
  targetRegions?: TargetRegions | null; targetRegionsInvalid?: string;
}
/** `gate_flags` (excluded jobs only): the soft flags computed anyway, persisted by saveGateResults while `flags` stays empty. */
export interface VetoResult { excluded: boolean; reason?: string; flags: string[]; gate_flags?: string[]; legitimacy?: Legitimacy; language_note?: string | null }

export function applyVetoes(
  m: { job_id: string; score: number; location_verdict?: Verdict; language_gate?: Verdict },
  job: { title: string; description: string; location?: string | null; remote?: boolean },
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
  // Backstop for the model's location verdict: a FAIL on a posting that names a target region (Gulf by default) is shown as a FLAG, never passed silently.
  let locationVerdict = m.location_verdict;
  // A restriction marker (residency, "US only", right to work in a non-target place...) in the location, title or the posting text keeps the FAIL.
  const regionHit = locationVerdict === 'FAIL' && extras?.targetRegions ? regionDowngrade(job, extras.targetRegions.targets) : null;
  if (regionHit) {
    locationVerdict = 'FLAG';
    soft.push(`location FLAG: the matcher said FAIL but the posting names target region "${regionHit}" (relocation, visa or residency may be needed: check the posting)`);
  } else if (locationVerdict === 'FLAG') soft.push('location FLAG');
  if (extras?.targetRegions === null) soft.push(`target regions config invalid: ${extras.targetRegionsInvalid ?? 'unreadable'}`);
  if (m.language_gate === 'FLAG' || ts?.verdict === 'FLAG') soft.push(ts?.verdict === 'FLAG' ? `language FLAG: ${ts.note}` : 'language FLAG');
  if (extras?.languages === null) soft.push(extras.languagesInvalid ? `language gate config invalid: ${extras.languagesInvalid}` : 'language gate config missing');
  const stale = extras ? staleFlag(extras.facts?.posted_at, now) : null;
  if (stale) soft.push(stale);
  if (legit?.tier === 'caution') for (const s of legit.signals.filter((x) => !x.startsWith('info:'))) soft.push(`legitimacy caution: ${s}`);
  const out = (r: Omit<VetoResult, 'legitimacy' | 'language_note'>): VetoResult =>
    ({ ...r, ...more, ...(extras && r.excluded ? { gate_flags: soft } : {}) });

  if (locationVerdict === 'FAIL') return out({ excluded: true, reason: 'location FAIL', flags });
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
  // A passed deadline excludes in the first run too (same rule as sweepDeadlines), unless we already acted on the job.
  if (extras?.facts?.deadline && !extras.facts.acted && !extras.facts.overridden && deadlinePassed(extras.facts.deadline, now)) {
    return out({ excluded: true, reason: `deadline passed: ${extras.facts.deadline.trim()}`, flags });
  }
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
  jobs: { id: string; title: string; description?: string | null; location?: string | null; remote?: boolean | null }[],
  keywords?: string[],
  ctx?: { facts?: Map<string, JobFacts>; now?: Date; languages?: LanguageConfig | null; languagesInvalid?: string; targetRegions?: TargetRegions | null; targetRegionsInvalid?: string },
): Array<{ job_id: string } & VetoResult> {
  const dealBreakers = (keywords ?? loadDealBreakers()).map((k) => k.trim()).filter(Boolean);
  const byId = new Map(jobs.map((j) => [j.id, { title: j.title, description: j.description ?? '', location: j.location ?? null, remote: j.remote ?? undefined }]));
  return results.map((r) => {
    const job = byId.get(r.job_id) ?? { title: '', description: '' };
    const extras = ctx ? { facts: ctx.facts?.get(r.job_id), now: ctx.now, languages: ctx.languages, languagesInvalid: ctx.languagesInvalid, targetRegions: ctx.targetRegions, targetRegionsInvalid: ctx.targetRegionsInvalid } : undefined;
    return { job_id: r.job_id, ...applyVetoes(r, job, dealBreakers, extras) };
  });
}
