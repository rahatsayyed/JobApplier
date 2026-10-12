// file: src/followups.ts
// Follow-up cadence and stale sweep, adapted from MadsLorentzen/ai-job-search .claude/commands/outcome.md (MIT, (c) 2026
// Mads Lorentzen): >= 10 quiet days, at most 2 follow-ups, draft-only until approved, 60-day stale -> no_response.
import type BetterSqlite3 from 'better-sqlite3';
import { recordOutcome } from './db.js';
import { normalizeText } from './atsText.js';
import { getBaseResume } from './resume.js';
import { checkTextWithNormalized } from './resumeFacts.js';

const DAY = 86_400_000;
const parseSqlTime = (s: string) => Date.parse(`${s.replace(' ', 'T')}Z`);
const daysBetween = (from: string, now: Date) => Math.floor((now.getTime() - parseSqlTime(from)) / DAY);
const sqlNow = (now: Date) => now.toISOString().slice(0, 19).replace('T', ' ');

export interface FollowupCandidate {
  job_id: string; company: string | null; title: string | null; email_to: string; subject: string | null; body: string | null;
  thread_id: string | null; message_id: string | null; sent_at: string; followups_sent: number; days_quiet: number; next_n: 1 | 2;
}

interface Row {
  job_id: string; company: string | null; title: string | null; email_to: string; subject: string | null; body: string | null;
  thread_id: string | null; message_id: string | null; sent_at: string; n_sent: number; last_fu: string | null; last_skip: string | null; pending: number;
}

function rows(db: BetterSqlite3.Database): Row[] {
  return db.prepare(`
    WITH sent AS (
      SELECT job_id, MIN(email_sent_at) AS sent_at, MAX(email_to) AS email_to, MAX(email_subject) AS subject, MAX(email_body) AS body,
             MAX(email_thread_id) AS thread_id, MAX(email_message_id) AS message_id
      FROM outreach_queue WHERE email_status = 'sent' AND email_sent_at IS NOT NULL GROUP BY job_id
    ), fu AS (
      SELECT job_id, SUM(status = 'sent') AS n_sent, MAX(CASE WHEN status = 'sent' THEN sent_at END) AS last_fu,
             MAX(CASE WHEN status = 'skipped' THEN decided_at END) AS last_skip, SUM(status IN ('drafted', 'approved')) AS pending
      FROM followups GROUP BY job_id
    )
    SELECT s.job_id, j.company, j.title, s.email_to, s.subject, s.body, s.thread_id, s.message_id, s.sent_at,
           coalesce(fu.n_sent, 0) AS n_sent, fu.last_fu, fu.last_skip, coalesce(fu.pending, 0) AS pending
    FROM sent s LEFT JOIN jobs j ON j.id = s.job_id LEFT JOIN fu ON fu.job_id = s.job_id`).all() as Row[];
}

/** Latest contact: the cold email, a sent follow-up, or the moment the user skipped a draft (so a skip does not make the job a candidate again at once). */
const lastContact = (r: Row) => [r.sent_at, r.last_fu, r.last_skip].filter((x): x is string => !!x).sort().pop() as string;

/** Jobs that must never get a (further) follow-up or a stale no_response: any outcome; any processed reply that is not noise or an
 *  auto-acknowledgement (replied, rejected, offer, interview, bounce, even a still-pending or skipped proposal); and every other job
 *  sent to the same address as a job with an outcome, a human reply, or a bounce. `jobs.excluded_reason` and include overrides are
 *  deliberately ignored (Plan 2 AF1/W9): an emailed job keeps its follow-up and stale handling. */
/** Bare lowercase address: `Jane <hr@x.com>` gives `hr@x.com`; a string without angle brackets is used whole. */
export const bare = (s: string): string => { const m = /<([^<>]{1,320})>/.exec(s.slice(0, 1000)); return (m ? m[1] : s).trim().toLowerCase(); };

export function blockedJobIds(db: BetterSqlite3.Database): Set<string> {
  const blocked = new Set<string>();
  const addrs = new Set<string>();
  const all = <T,>(sql: string) => db.prepare(sql).all() as T[];
  for (const r of all<{ job_id: string }>('SELECT DISTINCT job_id FROM job_outcomes')) blocked.add(r.job_id);
  for (const r of all<{ job_id: string }>("SELECT DISTINCT job_id FROM processed_messages WHERE job_id IS NOT NULL AND (classification NOT IN ('noise', 'auto_ack') OR coalesce(action, '') != 'ignored')")) blocked.add(r.job_id);
  // Z1: a no_response outcome blocks its own job (above) but does not propagate to siblings at the same address.
  for (const r of all<{ a: string }>("SELECT DISTINCT q.email_to AS a FROM outreach_queue q JOIN job_outcomes o ON o.job_id = q.job_id WHERE q.email_to IS NOT NULL AND o.outcome != 'no_response'")) addrs.add(bare(r.a));
  for (const r of all<{ a: string }>("SELECT DISTINCT from_addr AS a FROM processed_messages WHERE from_addr IS NOT NULL AND classification NOT IN ('noise', 'auto_ack', 'bounce') AND coalesce(action, '') != 'bounced'")) addrs.add(bare(r.a));
  for (const r of all<{ a: string }>("SELECT DISTINCT q.email_to AS a FROM processed_messages p JOIN outreach_queue q ON q.job_id = p.job_id WHERE (p.classification = 'bounce' OR p.action = 'bounced') AND q.email_to IS NOT NULL")) addrs.add(bare(r.a));
  for (const r of all<{ job_id: string; a: string }>("SELECT job_id, email_to AS a FROM outreach_queue WHERE email_to IS NOT NULL AND email_status = 'sent'")) if (addrs.has(bare(r.a))) blocked.add(r.job_id);
  return blocked;
}

export function listFollowupCandidates(db: BetterSqlite3.Database, now: Date = new Date(), opts: { afterDays?: number; max?: number } = {}): FollowupCandidate[] {
  const after = opts.afterDays ?? 10;
  const max = opts.max ?? 2;
  const blocked = blockedJobIds(db);
  return rows(db)
    .filter((r) => !blocked.has(r.job_id) && r.email_to && r.pending === 0 && r.n_sent < max && daysBetween(lastContact(r), now) >= after)
    .map((r) => ({
      job_id: r.job_id, company: r.company, title: r.title, email_to: r.email_to, subject: r.subject, body: r.body,
      thread_id: r.thread_id, message_id: r.message_id, sent_at: r.sent_at, followups_sent: r.n_sent,
      days_quiet: daysBetween(lastContact(r), now), next_n: (r.n_sent + 1) as 1 | 2,
    }));
}

// ---- Draft validation: the fact gate and the hard style rules run HERE, in code, not only in the prompt ----

export interface GateResult { verdict: 'pass' | 'warn' | 'block'; invented: string[]; unsupported: string[]; forbidden: string[]; warnings: string[]; normalized_text: string }
export type FollowupGate = (text: string, ctx: { extraSource: string; jobTitle: string | null; company: string | null }) => GateResult;

/** The real gate: `checkTextWithNormalized` (the function behind resume.check_text) over the base resume, with the original email as an extra source. */
export const makeGate = (getBase: () => Record<string, any>): FollowupGate => (text, ctx) =>
  checkTextWithNormalized(text, getBase(), { extraSource: ctx.extraSource, jobTitle: ctx.jobTitle ?? undefined, company: ctx.company ?? undefined });
export const realGate: FollowupGate = makeGate(getBaseResume);

/** config/fact-gate.json only lists three of these; the follow-up rules ban all of them. */
export const BANNED_FOLLOWUP = /just checking in|checking in|follow(?:ing)?[- ]?up|touching base|circling back|bump(?:ing)? (?:this|my)|\bany updates?\b|gentle reminder|per my last email/i;
export const FOLLOWUP_WORDS = { min: 40, max: 120 };

export interface SavedDraft { id: number; subject: string; body: string; warnings: string[] }

/** Stores a follow-up draft (status drafted, nothing is sent). Throws, storing nothing, unless the job is a current candidate, n is its next_n,
 *  the fact gate does not block (original email as extra source, job title and company blanked), the subject is `Re: <original subject>`,
 *  the body is 40-120 words and no banned phrase appears. Stores the gate's NORMALIZED subject and body (the text that was gated is the text that is sent). */
export function saveFollowupDraft(db: BetterSqlite3.Database, d: { job_id: string; n: number; subject: string; body: string }, now: Date = new Date(), gate: FollowupGate = realGate): SavedDraft {
  const c = listFollowupCandidates(db, now).find((x) => x.job_id === d.job_id);
  if (!c) throw new Error(`job ${d.job_id} is not a follow-up candidate (outcome or reply recorded, too recent, pending draft, or 2 already sent)`);
  if (d.n !== c.next_n) throw new Error(`expected follow-up #${c.next_n} for job ${d.job_id}, got #${d.n}`);
  if (/[\r\n]/.test(d.subject)) throw new Error('subject must be a single line');
  const g = gate(`${d.subject}\n\n${d.body}`, { extraSource: `${c.subject ?? ''}\n\n${c.body ?? ''}`, jobTitle: c.title, company: c.company });
  if (g.verdict === 'block') throw new Error(`fact gate blocked this draft: ${[...g.invented, ...g.unsupported, ...g.forbidden.map((p) => `forbidden:${p}`)].join(', ')}`);
  const cut = /\n[ \t]*\n/.exec(g.normalized_text);
  if (!cut) throw new Error('draft must be a subject line, a blank line, then the body');
  const subject = g.normalized_text.slice(0, cut.index).trim();
  const body = g.normalized_text.slice(cut.index + cut[0].length).trim();
  const expected = normalizeText(`Re: ${c.subject ?? ''}`).trim();
  if (subject !== expected) throw new Error(`subject must be exactly "${expected}"`);
  const banned = BANNED_FOLLOWUP.exec(`${subject}\n${body}`);
  if (banned) throw new Error(`banned phrase "${banned[0]}"`);
  const words = body.split(/\s+/).filter(Boolean).length;
  if (words < FOLLOWUP_WORDS.min || words > FOLLOWUP_WORDS.max) throw new Error(`body must be ${FOLLOWUP_WORDS.min}-${FOLLOWUP_WORDS.max} words, got ${words}`);
  const id = Number(db.prepare("INSERT INTO followups (job_id, n, subject, body, status) VALUES (?, ?, ?, ?, 'drafted')").run(d.job_id, d.n, subject, body).lastInsertRowid);
  return { id, subject, body, warnings: g.warnings };
}

/** Approve or skip drafted rows. The decision time is stored: a skip counts as the last contact so the job is not re-drafted at once. */
export function setFollowupApproval(db: BetterSqlite3.Database, ids: number[], approve: boolean): number {
  const upd = db.prepare("UPDATE followups SET status = ?, decided_at = datetime('now') WHERE id = ? AND status = 'drafted'");
  const jobOf = db.prepare("SELECT job_id FROM followups WHERE id = ? AND status = 'drafted'");
  const blocked = blockedJobIds(db);
  let n = 0;
  db.transaction(() => {
    for (const id of ids) {
      const j = (jobOf.get(id) as { job_id: string } | undefined)?.job_id;
      // A draft whose job became blocked (outcome, reply, bounce) is never approved: it is skipped and not counted.
      if (j !== undefined && blocked.has(j)) { upd.run('skipped', id); continue; }
      n += upd.run(approve ? 'approved' : 'skipped', id).changes;
    }
  })();
  return n;
}

/** Approved, unsent follow-ups, minus any job that has since got an outcome or a reply (even a pending proposal) or whose address bounced. */
export function listApprovedFollowups(db: BetterSqlite3.Database): Array<{ id: number; job_id: string; n: number; subject: string; body: string; email_to: string; thread_id: string | null }> {
  const blocked = blockedJobIds(db);
  const all = db.prepare(`SELECT f.id, f.job_id, f.n, f.subject, f.body,
      (SELECT MAX(q.email_to) FROM outreach_queue q WHERE q.job_id = f.job_id AND q.email_status = 'sent') AS email_to,
      (SELECT MAX(q.email_thread_id) FROM outreach_queue q WHERE q.job_id = f.job_id AND q.email_status = 'sent') AS thread_id
    FROM followups f WHERE f.status = 'approved' ORDER BY f.id`).all() as any[];
  return all.filter((r) => r.email_to && !blocked.has(r.job_id));
}

/** Called AFTER the email went out, so it records the truth: the row becomes `sent` even if the job got blocked in between (an outcome
 *  recorded meanwhile has already flipped an approved row to `skipped`; that row is still the one just sent). `late_block` tells the caller to warn
 *  the user ("sent, but a reply/outcome arrived meanwhile"). Pre-send protection lives in listApprovedFollowups and setFollowupApproval. */
export function markFollowupSent(db: BetterSqlite3.Database, id: number, messageId: string | null): { ok: boolean; late_block: boolean } {
  const row = db.prepare("SELECT job_id FROM followups WHERE id = ? AND status IN ('approved', 'skipped') AND sent_at IS NULL").get(id) as { job_id: string } | undefined;
  if (!row) return { ok: false, late_block: false };
  const late_block = blockedJobIds(db).has(row.job_id);
  const ok = db.prepare("UPDATE followups SET status = 'sent', sent_at = datetime('now'), message_id = ? WHERE id = ? AND status IN ('approved', 'skipped') AND sent_at IS NULL").run(messageId, id).changes > 0;
  return { ok, late_block: ok && late_block };
}

export function markFollowupFailed(db: BetterSqlite3.Database, id: number): boolean {
  return db.prepare("UPDATE followups SET status = 'failed' WHERE id = ? AND status = 'approved'").run(id).changes > 0;
}

export interface StaleCandidate { job_id: string; company: string | null; title: string | null; days_quiet: number; followups_sent: number; why: 'silent 60+ days' | 'no reply after 2 follow-ups' }

/** Sent jobs gone quiet. Jobs with an outcome, a reply (even an unresolved proposal) or a bounce are never listed: the user decides those. */
export function listStale(db: BetterSqlite3.Database, now: Date = new Date(), opts: { staleDays?: number; afterDays?: number; max?: number } = {}): StaleCandidate[] {
  const stale = opts.staleDays ?? 60;
  const after = opts.afterDays ?? 10;
  const max = opts.max ?? 2;
  const blocked = blockedJobIds(db);
  const out: StaleCandidate[] = [];
  for (const r of rows(db)) {
    if (blocked.has(r.job_id)) continue;
    const q = daysBetween(lastContact(r), now);
    const why = q >= stale ? 'silent 60+ days' : r.n_sent >= max && q >= after ? 'no reply after 2 follow-ups' : null;
    if (why) out.push({ job_id: r.job_id, company: r.company, title: r.title, days_quiet: q, followups_sent: r.n_sent, why });
  }
  return out;
}

export function resolveStale(db: BetterSqlite3.Database, jobIds: string[], now: Date = new Date()): { recorded: string[]; skipped: string[] } {
  const eligible = new Set(listStale(db, now).map((s) => s.job_id));
  const recorded: string[] = [];
  const skipped: string[] = [];
  db.transaction(() => {
    for (const id of jobIds) {
      if (!eligible.has(id)) { skipped.push(id); continue; }
      recordOutcome(db, id, 'no_response', `stale resolved no_response (${sqlNow(now).slice(0, 10)})`);
      recorded.push(id);
    }
  })();
  return { recorded, skipped };
}
