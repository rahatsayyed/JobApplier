// file: src/matchTool.ts
import { z } from 'zod';
import type BetterSqlite3 from 'better-sqlite3';
import { saveMatchResultsChecked } from './db.js';

/** Rows are validated one at a time in saveMatchResultsChecked / normalizeMatchRow, never here:
 *  a strict schema (or a missing job_id, or a null row) would reject the WHOLE call and stop the hunt. */
export const matchResultsInputShape = { results: z.array(z.unknown()) };

export function handleSaveMatchResults(db: BetterSqlite3.Database, args: { results: unknown[] }) {
  const out = saveMatchResultsChecked(db, args.results as any);
  return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
}
