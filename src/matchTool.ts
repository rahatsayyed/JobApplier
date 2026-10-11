// file: src/matchTool.ts
import { z } from 'zod';
import type BetterSqlite3 from 'better-sqlite3';
import { saveMatchResultsChecked } from './db.js';

/** Per-row shape is validated in normalizeMatchRow (score.ts), one row at a time, never here. */
export const matchRowSchema = z.object({
  job_id: z.string(),
  score: z.unknown().optional(),
  reasons: z.unknown().optional(),
  missing_keywords: z.unknown().optional(),
  location_verdict: z.unknown().optional(),
  language_gate: z.unknown().optional(),
  language_note: z.unknown().optional(),
  score_dims: z.unknown().optional(),
  requirements: z.unknown().optional(),
  strengths: z.unknown().optional(),
  gaps: z.unknown().optional(),
  deadline: z.unknown().optional(),
  error: z.unknown().optional(),
}).passthrough();

export const matchResultsInputShape = { results: z.array(matchRowSchema) };

export function handleSaveMatchResults(db: BetterSqlite3.Database, args: { results: unknown[] }) {
  const out = saveMatchResultsChecked(db, args.results as any);
  return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
}
