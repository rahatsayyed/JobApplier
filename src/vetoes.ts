import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Verdict = 'PASS' | 'FAIL' | 'FLAG';

export function applyVetoes(
  m: { job_id: string; score: number; location_verdict?: Verdict; language_gate?: Verdict },
  job: { title: string; description: string },
  dealBreakers: string[],
): { excluded: boolean; reason?: string; flags: string[] } {
  const flags: string[] = [];
  if (m.location_verdict === 'FAIL') return { excluded: true, reason: 'location FAIL', flags };
  if (m.language_gate === 'FAIL') return { excluded: true, reason: 'language FAIL', flags };
  const hay = `${job.title}\n${job.description}`.toLowerCase();
  for (const raw of dealBreakers) {
    const kw = raw?.trim();
    if (kw && hay.includes(kw.toLowerCase())) return { excluded: true, reason: `deal-breaker: ${kw}`, flags };
  }
  if (m.location_verdict === 'FLAG') flags.push('location FLAG');
  if (m.language_gate === 'FLAG') flags.push('language FLAG');
  return { excluded: false, flags };
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
): { job_id: string; excluded: boolean; reason?: string; flags: string[] }[] {
  const dealBreakers = (keywords ?? loadDealBreakers()).map((k) => k.trim()).filter(Boolean);
  const byId = new Map(jobs.map((j) => [j.id, { title: j.title, description: j.description ?? '' }]));
  return results.map((r) => {
    const job = byId.get(r.job_id) ?? { title: '', description: '' };
    return { job_id: r.job_id, ...applyVetoes(r, job, dealBreakers) };
  });
}
