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
  for (const kw of dealBreakers) {
    if (kw && hay.includes(kw.toLowerCase())) return { excluded: true, reason: `deal-breaker: ${kw}`, flags };
  }
  if (m.location_verdict === 'FLAG') flags.push('location FLAG');
  if (m.language_gate === 'FLAG') flags.push('language FLAG');
  return { excluded: false, flags };
}
