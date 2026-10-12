import { describe, it, expect } from 'vitest';
import { enqueueOutreach, openDb, recordEmailSent, recordOutcome, saveJob, setEmailThread } from '../src/db.js';
import { replyDate, resolveReplyProposals, triageReplies } from '../src/replyTriage.js';

const ON = { auto_record_enabled: true };
const OFF = { auto_record_enabled: false };

function setup() {
  const db = openDb(':memory:');
  for (const [id, company, to] of [['j1', 'Acme', 'hr@acme.dev'], ['j2', 'Globex', 'jobs@globex.io']]) {
    saveJob(db, { id, source: 's', title: 'Frontend Developer', company, url: 'u', apply_url: 'u', description: 'd' });
    const q = enqueueOutreach(db, { job_id: id, resume_pdf_path: null, email_subject: 'Frontend role', email_body: 'Hi', email_to: to, connect_note: null, connect_profile_url: null, connect_category: null, connect_company: null, apply_platform: null, apply_url: null });
    recordEmailSent(db, q, `m-${id}`);
    setEmailThread(db, `m-${id}`, `t-${id}`);
  }
  return db;
}
const outcomes = (db: any) => db.prepare('SELECT job_id, outcome FROM job_outcomes ORDER BY id').all();
const MIXED = [
  { message_id: 'a', thread_id: 't-j1', from: 'hr@acme.dev', subject: 'Re: Frontend role', body: 'Could you share your availability for a call?' },
  { message_id: 'b', from: 'lead@globex.io', subject: 'Re: Frontend role', body: 'We decided not to proceed.' },
  { message_id: 'c', thread_id: 't-j1', from: 'hr@acme.dev', subject: 'Offer', body: 'We are pleased to offer you the role.' },
  { message_id: 'd', from: 'x@gmail.com', subject: 'hello', body: 'random note' },
  { message_id: 'e', from: 'alerts@site.com', subject: 'Job alert: 5 new jobs', body: 'Recommended jobs' },
  { message_id: 'f', thread_id: 't-j2', from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', subject: 'Delivery Status Notification (Failure)', body: "Your message wasn't delivered to jobs@globex.io because the address couldn't be found." },
  { message_id: 'g', thread_id: 't-j1', from: 'hr@acme.dev', subject: 'Re: Frontend role', body: 'Thanks, will review.' },
  { message_id: 'h', thread_id: 't-j2', from: 'jobs@globex.io', subject: 'Automatic reply: Frontend role', body: 'I am out of the office until Monday.' },
];

describe('triageReplies', () => {
  it('auto-records only interview/rejected on a high match; proposes offers, plain replies and weaker matches; reports bounces and unmatched; ignores noise and out-of-office', () => {
    const db = setup();
    const r = triageReplies(db, MIXED, { config: ON });
    expect(r.auto_recorded).toEqual([{ message_id: 'a', job_id: 'j1', outcome: 'interview', from: 'hr@acme.dev', subject: 'Re: Frontend role' }]);
    expect(r.proposals.map((p) => [p.message_id, p.job_id, p.outcome])).toEqual([['b', 'j2', 'rejected'], ['c', 'j1', 'offer'], ['g', 'j1', 'replied']]);
    expect(r.bounced).toEqual([{ message_id: 'f', job_id: 'j2', from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', subject: 'Delivery Status Notification (Failure)' }]);
    expect(r.unmatched).toEqual([{ message_id: 'd', from: 'x@gmail.com', subject: 'hello', classification: 'replied' }]);
    expect(r.ignored).toBe(2);
    expect(outcomes(db)).toEqual([{ job_id: 'j1', outcome: 'interview' }]);
    expect(db.prepare("SELECT action, count(*) AS n FROM processed_messages GROUP BY action ORDER BY action").all()).toEqual([
      { action: 'bounced', n: 1 }, { action: 'ignored', n: 3 }, { action: 'proposed', n: 3 }, { action: 'recorded', n: 1 }]);
  });
  it('dry_run returns the same result but writes nothing', () => {
    const db = setup();
    const dry = triageReplies(db, MIXED, { dry_run: true, config: ON });
    expect(dry.dry_run).toBe(true);
    expect(dry.auto_recorded).toHaveLength(1);
    expect(outcomes(db)).toEqual([]);
    expect(db.prepare('SELECT count(*) AS n FROM processed_messages').get()).toEqual({ n: 0 });
    const real = triageReplies(db, MIXED, { config: ON });
    expect({ ...real, dry_run: true }).toEqual(dry);
  });
  it('a reply to an emailed job that was later excluded (plan 2) still matches and is recorded: exclusions never hide replies', () => {
    const db = setup();
    db.prepare("UPDATE jobs SET excluded_reason = 'deadline passed: 2026-10-01' WHERE id = 'j1'").run();
    const r = triageReplies(db, [{ message_id: 'ex', thread_id: 't-j1', from: 'hr@acme.dev', subject: 'Re: x', body: 'Could we schedule a call this week?' }], { config: ON });
    expect(r.auto_recorded.map((a) => [a.message_id, a.job_id, a.outcome])).toEqual([['ex', 'j1', 'interview']]);
  });
  it('never re-triages a processed message', () => {
    const db = setup();
    const m = { message_id: 'a', thread_id: 't-j1', from: 'hr@acme.dev', subject: 'Re: x', body: 'Could we schedule a call this week?' };
    triageReplies(db, [m], { config: ON });
    const again = triageReplies(db, [m], { config: ON });
    expect(again.already_processed).toBe(1);
    expect(outcomes(db)).toHaveLength(1);
  });
  it('never downgrades or flips the latest outcome (Y2 plus the Task 2 ladder): an interview already recorded is never auto-overwritten, everything else is proposed', () => {
    const db = setup();
    recordOutcome(db, 'j1', 'interview');
    const r = triageReplies(db, [
      { message_id: 'x1', thread_id: 't-j1', from: 'hr@acme.dev', subject: 'Re: x', body: 'Thanks! Can we connect on Friday?' },
      { message_id: 'x2', thread_id: 't-j1', from: 'hr@acme.dev', subject: 'Re: x', body: 'We regret to inform you that we will not move forward.' },
      { message_id: 'x3', thread_id: 't-j1', from: 'hr@acme.dev', subject: 'Re: x', body: 'Are you free for a call tomorrow?' },
    ], { config: ON });
    expect(r.auto_recorded).toEqual([]);
    expect(r.proposals.map((p) => p.message_id).sort()).toEqual(['x1', 'x2', 'x3']);
    expect(outcomes(db)).toEqual([{ job_id: 'j1', outcome: 'interview' }]);
  });
  it('a plain replied outcome can still be raised to interview automatically (enabled config only)', () => {
    const db = setup();
    recordOutcome(db, 'j1', 'replied');
    const r = triageReplies(db, [{ message_id: 'u1', thread_id: 't-j1', from: 'hr@acme.dev', subject: 'Re: x', body: 'Could we schedule a call this week?' }], { config: ON });
    expect(r.auto_recorded.map((a) => a.outcome)).toEqual(['interview']);
  });
  it('auto-record is off by default: with the disabled config everything is a proposal and no outcome is ever written', () => {
    const db = setup();
    const r = triageReplies(db, MIXED, { config: OFF });
    expect(r.auto_recorded).toEqual([]);
    expect(r.proposals.map((p) => p.message_id).sort()).toEqual(['a', 'b', 'c', 'g']);
    expect(outcomes(db)).toEqual([]);
    expect(db.prepare("SELECT count(*) AS n FROM processed_messages WHERE action = 'recorded'").get()).toEqual({ n: 0 });
  });
  it('processes dated messages oldest first and stores the reply date', () => {
    const db = setup();
    triageReplies(db, [
      { message_id: 'new', thread_id: 't-j1', from: 'hr@acme.dev', subject: 'Re: x', date: 'Wed, 3 Sep 2026 10:00:00 +0000', body: 'We regret to inform you that we will not move forward.' },
      { message_id: 'old', thread_id: 't-j1', from: 'hr@acme.dev', subject: 'Re: x', date: 'Tue, 2 Sep 2026 10:00:00 +0000', body: 'Could we schedule a call this week?' },
    ], { config: ON });
    expect(outcomes(db)).toEqual([{ job_id: 'j1', outcome: 'interview' }]);
    expect(db.prepare("SELECT message_id, action FROM processed_messages ORDER BY message_id").all()).toEqual([{ message_id: 'new', action: 'proposed' }, { message_id: 'old', action: 'recorded' }]);
    expect(db.prepare('SELECT message_id, reply_date, from_addr FROM processed_messages ORDER BY message_id').all()).toEqual([
      { message_id: 'new', reply_date: '2026-09-03 10:00:00', from_addr: 'hr@acme.dev' }, { message_id: 'old', reply_date: '2026-09-02 10:00:00', from_addr: 'hr@acme.dev' }]);
    expect(replyDate('not a date')).toBeNull();
    expect(replyDate(null)).toBeNull();
  });
});

describe('resolveReplyProposals', () => {
  it('records approved proposals, marks skipped ones, reports unknown ids', () => {
    const db = setup();
    triageReplies(db, [
      { message_id: 'b', from: 'lead@globex.io', subject: 'Re: x', body: 'We decided not to proceed.' },
      { message_id: 'c', thread_id: 't-j1', from: 'hr@acme.dev', subject: 'Offer', body: 'We are pleased to offer you the role.' },
    ], { config: OFF });
    expect(resolveReplyProposals(db, [{ message_id: 'b', approve: true }, { message_id: 'c', approve: false }, { message_id: 'zz', approve: true }])).toEqual({ recorded: 1, skipped: 1, unknown: ['zz'] });
    expect(outcomes(db)).toEqual([{ job_id: 'j2', outcome: 'rejected' }]);
    expect(resolveReplyProposals(db, [{ message_id: 'b', approve: true }])).toEqual({ recorded: 0, skipped: 0, unknown: ['b'] });
  });
});

describe('resolveReplyProposals safety', () => {
  it('only records proposals that exist; an auto-recorded message id is unknown', () => {
    const db = setup();
    triageReplies(db, [{ message_id: 'a', thread_id: 't-j1', from: 'hr@acme.dev', subject: 'Re: x', body: 'Could we schedule a call this week?' }], { config: ON });
    expect(resolveReplyProposals(db, [{ message_id: 'a', approve: true }])).toEqual({ recorded: 0, skipped: 0, unknown: ['a'] });
    expect(outcomes(db)).toHaveLength(1);
  });
});
