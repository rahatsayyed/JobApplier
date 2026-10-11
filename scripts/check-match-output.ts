// Validate a saved matcher output against the code invariants, before trusting a prompt change.
//   npx tsx scripts/check-match-output.ts <matcher-output.json> <jobs.json>
// Prints per-row errors and a summary; exit 1 on any invalid row or any critical/high row backed only by inference.
import { readFileSync } from 'node:fs';
import { normalizeMatchRow } from '../src/score.js';

const [outFile, jobsFile] = process.argv.slice(2);
if (!outFile || !jobsFile) { console.error('usage: npx tsx scripts/check-match-output.ts <matcher-output.json> <jobs.json>'); process.exit(2); }
const rows = JSON.parse(readFileSync(outFile, 'utf8')) as any[];
const jobs = new Map((JSON.parse(readFileSync(jobsFile, 'utf8')) as any[]).map((j) => [j.id, j]));
let bad = 0;
for (const r of rows) {
  if (r.error) { console.error(`${r.job_id}: ${r.error}`); bad++; continue; }
  const n = normalizeMatchRow(r, jobs.get(r.job_id)?.description);
  if (!n.ok) { console.error(`${r.job_id}: ${n.error}`); bad++; continue; }
  const demoted = (r.requirements ?? []).filter((q: any) => q.evidence === 'stated').length - n.row.requirements.filter((q) => q.evidence === 'stated').length;
  const top = n.row.requirements.filter((q) => q.importance === 'critical' || q.importance === 'high');
  // The code silently demotes inferred critical/high rows; the model was told not to produce them, so count them as a prompt failure.
  const inferredTop = (r.requirements ?? []).filter((q: any) => q.evidence === 'inferred' && (q.importance === 'critical' || q.importance === 'high')).length;
  console.log(JSON.stringify({ job_id: r.job_id, score: n.row.score, model_score: r.score, cap: n.row.score_cap_reason, rows: n.row.requirements.length, top: top.length,
    stated_quotes_not_found: demoted, hard_stops: n.row.hard_stops, strengths: n.row.strengths.length, gaps: n.row.gaps.length, confidence: n.row.confidence, deadline: n.row.deadline ?? null,
    location_verdict: n.row.location_verdict ?? null, language_gate: n.row.language_gate ?? null }));
  if (!n.row.strengths.length || !n.row.gaps.length) { console.error(`${r.job_id}: strengths and gaps must each have 1-3 items`); bad++; }
  if (inferredTop) { console.error(`${r.job_id}: ${inferredTop} critical/high row(s) backed only by inference`); bad++; }
}
console.error(bad ? `INVALID: ${bad} row(s)` : 'OK');
process.exit(bad ? 1 : 0);
