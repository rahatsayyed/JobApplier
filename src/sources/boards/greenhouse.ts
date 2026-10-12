// Adapted from career-ops-hq/career-ops providers/greenhouse.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama). See that repo's LICENSE.
import { toIsoDay, type Job } from '../../db.js';
import { isSafeFetchUrl } from '../../liveness.js';
import { assertSlug, htmlToPlain, MAX_DESCRIPTION_CHARS, safeVendorUrl, type TrackedCompany } from './filters.js';

export interface BoardJob extends Job { locations: string[]; remote: boolean }

export const BOARD_TIMEOUT_MS = 20_000;
export const MAX_BODY_BYTES = 15 * 1024 * 1024;
export const BOARD_HEADERS = { 'User-Agent': 'jobapplier/1.0 (personal job search; contact via repo owner)', Accept: 'application/json' };
const ALLOWED_API_HOSTS = new Set(['boards-api.greenhouse.io', 'api.lever.co', 'api.eu.lever.co', 'api.ashbyhq.com']);

// Same idea as the module-private readBodyCapped in src/liveness.ts (not exported, and it truncates), but a board body cut off mid-JSON is useless, so exceeding the cap rejects.
async function readBodyCapped(res: Response, label: string): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    try { await res.body?.cancel(); } catch { /* best effort */ }
    throw new Error(`${label}: response too large`);
  }
  const reader = res.body?.getReader?.();
  if (!reader) {
    const t = await res.text();
    if (Buffer.byteLength(t) > MAX_BODY_BYTES) throw new Error(`${label}: response too large`);
    return t;
  }
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    received += value.length;
    if (received > MAX_BODY_BYTES) { await reader.cancel().catch(() => {}); throw new Error(`${label}: response too large`); }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export async function getJson(url: string, label: string): Promise<any> {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`${label}: host not allowed`); }
  if (u.protocol !== 'https:' || !ALLOWED_API_HOSTS.has(u.hostname) || !isSafeFetchUrl(url)) throw new Error(`${label}: host not allowed`);
  const signal = AbortSignal.timeout(BOARD_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { headers: BOARD_HEADERS, signal, redirect: 'error' });
  } catch (e: any) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    throw new Error(`${label}: ${timedOut ? 'timeout' : `request failed (${String(e?.cause?.message ?? e?.message ?? e).slice(0, 120)})`}`);
  }
  if (!res.ok) {
    try { await res.body?.cancel(); } catch { /* best effort */ }
    throw new Error(`${label}: HTTP ${res.status}`);
  }
  let text: string;
  try { text = await readBodyCapped(res, label); } catch (e: any) {
    if (typeof e?.message === 'string' && e.message.startsWith(`${label}:`)) throw e;
    throw new Error(`${label}: ${e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'read failed'}`);
  }
  try { return JSON.parse(text); } catch { throw new Error(`${label}: invalid JSON`); }
}

export interface BoardResult { jobs: BoardJob[]; error: string | null }
// Never-throwing wrapper over a provider fetch, so one bad board becomes a reportable error string (for board_status).
export async function settleBoard(fn: (c: TrackedCompany) => Promise<BoardJob[]>, c: TrackedCompany): Promise<BoardResult> {
  try { return { jobs: await fn(c), error: null }; } catch (e: any) { return { jobs: [], error: String(e?.message ?? e).slice(0, 300) }; }
}

export const MAX_JOBS_PER_BOARD = 2000;
export const MAX_TEXT_CHARS = 300;
export const MAX_URL_CHARS = 2000;
export const MAX_ID_CHARS = 100;
export const clip = (s: string): string => s.slice(0, MAX_TEXT_CHARS);
// Vendor URL (https, vendor host) that is also not over-long; otherwise the canonical one.
export function boardUrl(candidate: unknown, apex: string, canonical: string): string {
  const u = safeVendorUrl(candidate, apex, canonical);
  return u.length > MAX_URL_CHARS ? canonical : u;
}
// Drop query and fragment so a suffix can be appended to a vendor URL.
export const stripQuery = (u: string): string => u.replace(/[?#][\s\S]*$/, '').replace(/\/$/, '');
export const capDescription = (s: string): string => s.slice(0, MAX_DESCRIPTION_CHARS);

// Throws on an invalid slug (settleBoard turns that into a labelled error).
export function normalizeGreenhouse(raw: any, c: TrackedCompany): BoardJob[] {
  assertSlug(c.slug);
  const jobs = (Array.isArray(raw?.jobs) ? raw.jobs : []).slice(0, MAX_JOBS_PER_BOARD);
  const out: BoardJob[] = [];
  for (const j of jobs) {
    if (!j || j.id == null || !/^\d+$/.test(String(j.id)) || typeof j.title !== 'string') continue;
    if (`gh:${c.slug}:${j.id}`.length > MAX_ID_CHARS) continue;
    const loc = clip(typeof j.location?.name === 'string' ? j.location.name : '');
    const posted = toIsoDay(j.first_published ?? j.updated_at);
    const canonical = `https://boards.greenhouse.io/${c.slug}/jobs/${j.id}`;
    out.push({
      id: `gh:${c.slug}:${j.id}`,
      source: 'greenhouse',
      title: clip(j.title),
      company: c.name,
      url: boardUrl(j.absolute_url, 'greenhouse.io', canonical),
      apply_url: canonical,
      description: capDescription(htmlToPlain(typeof j.content === 'string' ? j.content : '')),
      ...(posted ? { posted_at: posted } : {}),
      locations: [loc],
      remote: /remote/i.test(loc),
    });
  }
  return out;
}

export async function fetchGreenhouse(c: TrackedCompany): Promise<BoardJob[]> {
  assertSlug(c.slug);
  const raw = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(c.slug)}/jobs?content=true`, `greenhouse ${c.slug}`);
  return normalizeGreenhouse(raw, c);
}
