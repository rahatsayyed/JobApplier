// Zero-LLM discovery from public ATS job boards listed in config/portals.json.
// Boards use ONLY the filters in config/portals.json; the role/location passed to fetchAllJobs / list_new_jobs do NOT apply here.
// This module never opens the database (src/mcp/job-fetch.ts does the db-side dedupe).
import type { Job } from '../../db.js';
import { companyKey, titleIdentityKey } from '../../reposts.js';
import { loadPortals, locationAllowed, titlePasses, type Ats, type TrackedCompany } from './filters.js';
import { fetchGreenhouse, settleBoard, type BoardJob } from './greenhouse.js';
import { fetchLever } from './lever.js';
import { fetchAshby } from './ashby.js';

export interface BoardsResult { jobs: Job[]; errors: string[]; stats: Array<{ company: string; ats: Ats; fetched: number; kept: number }> }

export const DESCRIPTION_CAP = 8000;
export const MAX_CONCURRENCY = 3;
export const DEFAULT_MAX_PER_COMPANY = 200;
export const DEFAULT_BOARD_TIMEOUT_MS = 30_000;
export const DEFAULT_BUDGET_MS = 120_000;
export const BOARD_SOURCES = new Set<string>(['greenhouse', 'lever', 'ashby']);
const capText = (s: string, n = DESCRIPTION_CAP) => (s.length > n ? s.slice(0, n).trimEnd() : s);

const FETCHERS: Record<Ats, (c: TrackedCompany) => Promise<BoardJob[]>> = { greenhouse: fetchGreenhouse, lever: fetchLever, ashby: fetchAshby };

export interface FetchBoardsOptions {
  configPath?: string;
  /** Boards in flight at once (default and maximum 3). */
  concurrency?: number;
  /** Kept jobs per company AFTER the title/location filters (default 200). */
  maxPerCompany?: number;
  /** Hard wall-clock limit for one board (default 30 s). */
  boardTimeoutMs?: number;
  /** Wall-clock limit for the whole fetch (default 120 s); boards not started by then are reported as errors. */
  budgetMs?: number;
}

let last: (BoardsResult & { at: string }) | null = null;
/** The most recent fetchBoards() result in this process (read by the job-fetch `board_status` tool). */
export function getLastBoardsResult(): (BoardsResult & { at: string }) | null { return last; }

/** Payload of the read-only job-fetch `board_status` tool: the last result, or ran:false. Never triggers a fetch. */
export function boardStatusPayload(r: (BoardsResult & { at: string }) | null = last) {
  if (!r) return { ran: false as const, errors: [] as string[], stats: [] as BoardsResult['stats'], note: 'no board fetch has run in this session' };
  return { ran: true as const, at: r.at, errors: r.errors, stats: r.stats };
}

type Slot = { c: TrackedCompany; jobs?: BoardJob[]; error?: string };

async function runBoards(opts: FetchBoardsOptions): Promise<BoardsResult> {
  const { config, error } = loadPortals(opts.configPath);
  if (error) return { jobs: [], errors: [error], stats: [] };
  if (!config) return { jobs: [], errors: [], stats: [] };
  const companies = config.tracked_companies.filter((c) => c.enabled);
  const max = opts.maxPerCompany ?? DEFAULT_MAX_PER_COMPANY;
  const boardTimeout = opts.boardTimeoutMs ?? DEFAULT_BOARD_TIMEOUT_MS;
  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const slots: Slot[] = new Array(companies.length);
  let next = 0;
  const worker = async () => {
    while (next < companies.length) {
      const i = next++;
      const c = companies[i];
      const label = `${c.ats} ${c.slug}`;
      const remaining = deadline - Date.now();
      if (remaining <= 0) { slots[i] = { c, error: `${label}: skipped, time budget exhausted` }; continue; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<{ jobs: BoardJob[]; error: string | null }>((resolve) => {
        timer = setTimeout(() => resolve({ jobs: [], error: `${label}: timeout` }), Math.min(boardTimeout, remaining));
      });
      try {
        const r = await Promise.race([settleBoard(FETCHERS[c.ats], c), timeout]);
        slots[i] = r.error ? { c, error: r.error.startsWith(`${label}:`) ? r.error : `${label}: ${r.error}` } : { c, jobs: r.jobs };
      } catch (e: any) {
        slots[i] = { c, error: `${label}: ${String(e?.message ?? e).slice(0, 300)}` };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  };
  const n = Math.max(1, Math.min(Math.floor(opts.concurrency ?? MAX_CONCURRENCY) || 1, MAX_CONCURRENCY, companies.length));
  await Promise.all(Array.from({ length: companies.length ? n : 0 }, worker));

  const out: BoardsResult = { jobs: [], errors: [], stats: [] };
  const seen = new Set<string>();
  for (const s of slots) {
    if (s.error) { out.errors.push(s.error); continue; }
    const fetched = s.jobs ?? [];
    const kept = fetched
      .filter((j) => titlePasses(j.title, config.title_filter) && locationAllowed(j.locations, j.remote, config.location_filter))
      .slice(0, max);
    for (const { locations: _l, remote: _r, ...job } of kept) {
      if (seen.has(job.id)) continue;
      seen.add(job.id);
      out.jobs.push({ ...job, description: capText(job.description) });
    }
    out.stats.push({ company: s.c.name, ats: s.c.ats, fetched: fetched.length, kept: kept.length });
  }
  for (const e of out.errors) console.error(`[boards] ${e}`);
  return out;
}

/** Never rejects for a board-level problem: failures are returned in `errors`. */
export async function fetchBoards(opts: FetchBoardsOptions = {}): Promise<BoardsResult> {
  const r = await runBoards(opts);
  last = { ...r, at: new Date().toISOString() };
  return r;
}

export interface SeenRow { id: string; source: string | null; company_key: string | null; title_key: string | null }

/**
 * Cross-source dedupe: the same posting often arrives via LinkedIn/Adzuna AND a company board under different ids.
 * Drop a board-source job whose normalized company+title (Plan 2's companyKey/titleIdentityKey) already appears in
 * `recent` (rows saved lately, any source) or in a non-board job of this batch, and collapse duplicates among board jobs.
 * Non-board jobs are never dropped.
 */
export function dropBoardDuplicates(jobs: Job[], recent: SeenRow[]): Job[] {
  const keyOf = (j: Job) => { const c = companyKey(j.company); const t = titleIdentityKey(j.title); return c && t ? `${c}|${t}` : ''; };
  const seen = new Set<string>();
  for (const r of recent) if (r.company_key && r.title_key) seen.add(`${r.company_key}|${r.title_key}`);
  for (const j of jobs) if (!BOARD_SOURCES.has(j.source)) { const k = keyOf(j); if (k) seen.add(k); }
  return jobs.filter((j) => {
    if (!BOARD_SOURCES.has(j.source)) return true;
    const k = keyOf(j);
    if (!k) return true;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
