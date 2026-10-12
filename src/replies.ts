// file: src/replies.ts
// Adapted from career-ops-hq/career-ops reply-matcher.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama) and
// MadsLorentzen/ai-job-search .claude/commands/gmail-sync.md (MIT, (c) 2026 Mads Lorentzen). See those repos' LICENSE files.
// Reply text is untrusted input: every scanned string is clamped (MAX_SCAN) and every regex quantifier below is bounded or linear.
import type { Outcome, SentEmail } from './db.js';

export type ReplyClass = 'bounce' | 'noise' | 'auto_ack' | 'rejected' | 'offer' | 'interview' | 'replied' | 'unknown';
export interface IncomingMessage { message_id: string; thread_id?: string | null; from: string; subject: string; date?: string | null; body: string }
export interface ReplyMatch { job_id: string | null; confidence: 'high' | 'medium' | 'low' | 'none'; via: 'thread' | 'sender' | 'domain' | 'company' | 'ambiguous' | 'none' }
export interface ReplyDecision { action: 'auto_record' | 'propose' | 'ignore' | 'report'; outcome: Outcome | null; reason: string }

const MAX_SCAN = 20000;
const clamp = (s: unknown, n = MAX_SCAN): string => String(s ?? '').slice(0, n);

const BOUNCE_SENDER = /\b(?:mailer-daemon|mailerdaemon|postmaster|mail delivery (?:sub)?system)\b/i;
const BOUNCE_TEXT = [/delivery status notification/i, /\bundeliverable\b/i, /\bundelivered mail\b/i, /\b(?:wasn't|was not|could not be|couldn't be|failed to be) delivered\b/i,
  /\baddress not found\b/i, /\bdelivery has failed\b/i, /\bmail delivery failed\b/i, /\bdelivery failure\b/i, /\bno such user\b|\buser unknown\b/i,
  /\b(?:mailbox|inbox) (?:is )?(?:full|unavailable|not found)\b/i, /\b5\d\d [45]\.\d\.\d\b/];
const NOISE = [/\bjob alerts?\b/i, /\bjobs you may be interested in\b/i, /\brecommended jobs\b/i, /\bnewsletter\b/i, /\bwebinar\b/i];
const OUT_OF_OFFICE = [/\bout of (?:the )?office\b/i, /\bautomatic reply\b|\bauto[- ]?repl(?:y|ied)\b|\bautoreply\b/i,
  /\b(?:i am|i'm|i will be|i'll be|currently|we are|we're) (?:currently )?(?:away|on (?:vacation|leave|holiday|annual leave|pto|maternity leave|sabbatical)|out of town|travell?ing|unavailable)\b/i,
  /\baway until\b|\baway from (?:my )?(?:desk|email)\b/i, /\bon (?:vacation|leave|holiday) until\b/i, /\bwith (?:limited|no) (?:access to )?(?:e-?mail|internet)\b/i,
  /\bwill (?:respond|reply|get back to you|be back|return)\b[^.]{0,30}\b(?:when|once|after|upon) i\b/i];
const REJECTED = [/\bregret to (?:inform|tell|let)\b/i, /\bdecided (?:not to|to not) (?:proceed|move forward|progress|pursue|continue|move ahead|take)\b/i,
  /\b(?:will not|won't|are not|aren't|am not|not|cannot|can't|unable to)\s+(?:be\s+)?(?:move|moving|proceed|proceeding|progress|progressing|go|going|take|taking)\s+(?:ahead|forward|further|on|with|your|this)\b/i,
  /\b(?:proceed(?:ed|ing)?|mov(?:e|ed|ing)|go(?:ne|ing)?)\s+(?:ahead\s+|forward\s+)?with\s+(?:other|another|different|someone|a different)\b/i,
  /\bpursu(?:e|ing) other (?:candidates|applicants)\b/i, /\bfound (?:another|a better) (?:candidate|fit)\b/i,
  /\b(?:position|role|job|vacancy|opening|requisition) (?:has|have) been (?:filled|closed|cancell?ed|put on hold)\b/i,
  /\bno longer (?:available|open|accepting|considering|hiring|looking)\b/i, /\bnot (?:been )?(?:selected|shortlisted|chosen)\b/i,
  /\bnot (?:a )?(?:good )?(?:fit|match)\b/i, /\b(?:(?:are|is|am) not|aren't|isn't|'re not|'m not)\s+(?:currently\s+)?(?:hiring|looking|recruiting|accepting)\b/i,
  /\b(?:don't|do not|doesn't|does not|have no|has no)\s+(?:currently\s+)?(?:have\s+)?(?:a\s+|any\s+)?(?:suitable\s+|matching\s+|relevant\s+|open\s+|current\s+|available\s+)*(?:openings?|positions?|vacanc(?:y|ies)|roles?)\b/i,
  /\bunable to (?:offer|proceed|move forward|consider)\b/i, /\bno (?:open )?(?:positions|openings|vacancies)\b/i];
const OFFER = [/\b(?:pleased|delighted|happy|thrilled) to offer\b/i, /\boffer letter\b/i, /\bextend(?:ing)? (?:you )?an offer\b/i, /\bmake you an offer\b/i,
  /\boffer you (?:the|a) (?:role|position|job)\b/i, /\bjob offer\b/i, /\boffer of employment\b/i];
const INTERVIEW = [/\b(?:schedule|scheduling|set up|setting up|arrange|arranging|book|booking|organi[sz]e)\s+(?:a|an|the|your|our|some|another|that|this)?\s*(?:[\w-]+\s+){0,3}?(?:call|chat|interview|meeting|conversation|discussion|round|time|slot|screening)\b/i,
  /\binvit(?:e|ing|ed) you to (?:an? |our |the )?(?:[\w-]+\s+){0,2}?(?:interview|call|chat|meeting|round|assessment|screen)/i,
  /\binterview (?:invitation|invite|slot|schedule|round|panel|link|time)\b/i, /\b(?:first|second|technical|final|initial|phone|video|intro(?:ductory)?|screening|hr) (?:round|interview|screen|call)\b/i,
  /\byour availability\b/i, /\bare you (?:free|available)\b/i, /\bwhen (?:are|would) you (?:free|be available|available)\b/i, /\b(?:free|available) (?:on|this|next|tomorrow|today|at|for a)\b/i,
  /\b(?:can|could) we (?:connect|talk|chat|speak|catch up|hop on|jump on|do|meet|move|reschedule|discuss|schedule)\b/i, /\blet'?s (?:connect|talk|chat|speak|catch up|schedule|set up|hop)\b/i,
  /\b(?:call|speak|talk|chat|meet)(?: with| to)? you (?:tomorrow|today|this week|next week|on (?:mon|tue|wed|thu|fri))/i,
  /\b(?:will|would like to|want to|like to|can|could) (?:call|phone|ring) you\b/i, /\bgive you a (?:call|ring)\b/i,
  /\bcalendly\.com\b|\bcal\.com\/|\bzoom\.us\b|\bmeet\.google\.com\b/i, /\btime slots?\b/i, /^\s*(?:updated\s+)?invitation:/im,
  /\b(?:coding|technical|take[\s-]home) (?:challenge|assessment|round|test|task|exercise)\b/i, /\bhackerrank\b|\bcodility\b|\bcodesignal\b|\bonline (?:test|assessment)\b|\bcomplete this (?:test|assessment)\b/i];
const AUTO_ACK = [/\b(?:we have|we've|we) received your (?:application|email|e-mail|message|request|resume|cv|enquiry|inquiry)\b/i,
  /\byour (?:application|request|message|email) (?:has|have) been (?:received|submitted|forwarded)\b/i, /\bthis is an? (?:automated|automatic|auto-generated)\b/i,
  /\bplease do not reply\b|\bdo not reply to this\b/i, /\bthank(?:s| you) for (?:contacting|applying|your (?:application|interest|email|message|submission))\b/i,
  /\b(?:get back to you|reach out|contact you|be in touch|let you know) if\b/i, /\bwill (?:get back|respond|reply|revert) to you (?:shortly|soon|within)\b/i,
  /\bwill be (?:reviewed|reviewing|considered)\b/i, /\bunder review\b/i, /\brespond within \d+/i];
// A sentence that only says what happens "if/should/once" something occurs is not a statement about THIS application.
const CONDITIONAL = /\b(?:if|in case|should|unless|once|whenever)\b/i;

const ent: Record<string, string> = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };

/** HTML-only mail (gmail.read_email returns the raw HTML when there is no text part): cut quoted history, then strip tags. All quantifiers bounded. */
function htmlToText(html: string): string {
  const cut = html.search(/<[a-z][^>]{0,500}?(?:class="[^"]{0,200}gmail_quote|id="(?:divRplyFwdMsg|appendonsend)")|<blockquote/i);
  const head = cut >= 0 ? html.slice(0, cut) : html;
  return head
    .replace(/<(style|script|head)\b[\s\S]{0,5000}?<\/\1>/gi, ' ')
    .replace(/<br\s{0,20}\/?>|<\/(?:p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]{1,500}>/g, '')
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos|#39);/g, (e) => ent[e] ?? e)
    .replace(/[ \t]+\n/g, '\n');
}

/** Cut quoted history so our own words cannot classify the reply: HTML quotes, "> " lines, "On ... wrote:", Outlook headers/underscore lines, forwarded blocks. */
export function stripQuoted(body: string): string {
  const raw = clamp(body);
  const text = /<\s*(?:html|body|div|p|br|blockquote|span|table|a)\b/i.test(raw) ? htmlToText(raw) : raw;
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1] ?? '';
    if (/^\s*On\b.{3,250}\bwrote:\s*$/.test(line) || (/^\s*On\b.{3,250}$/.test(line) && /^\s*wrote:\s*$/.test(next))) break;
    if (/^-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}/i.test(line.trim()) || /^_{5,}\s*$/.test(line.trim())) break;
    if (/^\s*From:\s.+@/.test(line)) break;
    if (/^\s*From:\s/.test(line) && lines.slice(i + 1, i + 6).some((l) => /^\s*(?:Sent|Date|To|Cc|Subject):/i.test(l))) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

const sentences = (t: string) => t.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Defence in depth for quote styles `stripQuoted` does not know: drop every reply sentence (20+ chars) that is verbatim a sentence of OUR sent email. */
function withoutOurs(text: string, ours: string): string {
  if (!ours.trim()) return text;
  const o = ` ${norm(clamp(ours))} `;
  return sentences(text).filter((s) => { const n = norm(s); return n.length < 20 || !o.includes(` ${n} `); }).join('\n');
}

/** Bounce first (never an outcome), then noise, out-of-office, rejected, offer, interview, auto-acknowledgement, any other human text = replied.
 *  `ours` is the text of the email we sent: reply sentences copied verbatim from it (an unmarked quote) never count as signals. */
export function classifyReply(subject: string, body: string, from = '', ours = ''): ReplyClass {
  const own = withoutOurs(stripQuoted(body), ours);
  const head = own.slice(0, 3000).replace(/[‘’]/g, "'");
  const subj = clamp(subject, 1000).replace(/[‘’]/g, "'");
  const text = `${subj}\n${head}`;
  if (BOUNCE_SENDER.test(clamp(from, 500)) || BOUNCE_TEXT.some((r) => r.test(text))) return 'bounce';
  if (NOISE.some((r) => r.test(text))) return 'noise';
  if (OUT_OF_OFFICE.some((r) => r.test(text))) return 'auto_ack';
  const firm = [subj, ...sentences(head)].filter((s) => !CONDITIONAL.test(s)).join('\n');
  if (REJECTED.some((r) => r.test(firm))) return 'rejected';
  if (OFFER.some((r) => r.test(firm))) return 'offer';
  if (INTERVIEW.some((r) => r.test(firm))) return 'interview';
  if (AUTO_ACK.some((r) => r.test(text))) return 'auto_ack';
  return own.trim() ? 'replied' : 'unknown';
}

const SHARED = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'rediffmail.com',
  'linkedin.com', 'greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkday.com', 'workday.com', 'smartrecruiters.com', 'icims.com', 'naukri.com', 'indeed.com', 'wellfound.com']);
const ATS_SENDERS = ['greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkday.com', 'smartrecruiters.com', 'icims.com'];

export function emailAddress(from: string): string | null {
  const f = clamp(from, 500);
  const m = /<([^>\s]+@[^>\s]+)>/.exec(f) ?? /([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/.exec(f);
  return m ? m[1].toLowerCase() : null;
}

export function domainOf(addr: string | null | undefined): string | null {
  const m = /@([\w.-]+)$/.exec(clamp(addr, 500).trim().toLowerCase());
  return m ? m[1] : null;
}

const LEGAL = /\b(?:inc|llc|ltd|limited|pvt|private|plc|gmbh|corp|corporation|co|company|llp)\b\.?/g;
const normCompany = (c: string) => c.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(LEGAL, ' ').replace(/\s+/g, ' ').trim();
function companyMentioned(text: string, company: string | null): boolean {
  if (!company) return false;
  const key = normCompany(company);
  if (!key) return false;
  const hay = ` ${text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  return hay.includes(` ${key} `);
}

function pick(level: ReplyMatch['confidence'], via: ReplyMatch['via'], hits: SentEmail[]): ReplyMatch | null {
  const ids = [...new Set(hits.map((h) => h.job_id))];
  if (ids.length === 1) return { job_id: ids[0], confidence: level, via };
  if (ids.length > 1) return { job_id: null, confidence: 'none', via: 'ambiguous' };
  return null;
}

export function matchReply(msg: IncomingMessage, sent: SentEmail[]): ReplyMatch {
  if (msg.thread_id) {
    const r = pick('high', 'thread', sent.filter((s) => s.thread_id && s.thread_id === msg.thread_id));
    if (r) return r;
  }
  const addr = emailAddress(msg.from);
  if (addr) {
    const r = pick('high', 'sender', sent.filter((s) => (s.email_to ?? '').toLowerCase() === addr));
    if (r) return r;
    const dom = domainOf(addr);
    if (dom && !SHARED.has(dom)) {
      const r2 = pick('medium', 'domain', sent.filter((s) => domainOf(s.email_to) === dom));
      if (r2) return r2;
    }
  }
  const hay = `${clamp(msg.subject, 1000)}\n${stripQuoted(msg.body)}`;
  const r3 = pick('low', 'company', sent.filter((s) => companyMentioned(hay, s.company)));
  return r3 ?? { job_id: null, confidence: 'none', via: 'none' };
}

// Progress rank used so an automatic record never downgrades the latest outcome (interview -> replied). A rejection after an
// interview is real progress (rank 3 > 2); anything after an offer or hire needs the user.
const RANK: Record<Outcome, number> = { no_response: 0, replied: 1, interview: 2, rejected: 3, offer: 4, hired: 5 };
const OUTCOME: Partial<Record<ReplyClass, Outcome>> = { rejected: 'rejected', offer: 'offer', interview: 'interview', replied: 'replied' };

/** Only `interview` and `rejected` (strong phrase hits) are ever auto-recorded, only on a high-confidence match, and only if
 *  the job has no outcome yet or the new class ranks strictly higher. `replied` and `offer` are always proposed. A bounce is
 *  never an outcome: it is reported. */
export function decideReply(cls: ReplyClass, m: ReplyMatch, latest: Outcome | null = null): ReplyDecision {
  if (cls === 'bounce') return { action: 'report', outcome: null, reason: m.job_id ? `bounce for job ${m.job_id} via ${m.via}` : 'bounce (job unknown)' };
  const outcome = OUTCOME[cls] ?? null;
  if (!outcome) return { action: 'ignore', outcome: null, reason: `${cls} is not an outcome` };
  if (!m.job_id) return { action: 'ignore', outcome: null, reason: `unmatched (${m.via})` };
  if (cls === 'offer') return { action: 'propose', outcome, reason: 'offers always need approval' };
  if (cls === 'replied') return { action: 'propose', outcome, reason: 'a plain reply is proposed, never auto-recorded' };
  if (m.confidence !== 'high') return { action: 'propose', outcome, reason: `${m.confidence}-confidence match via ${m.via}` };
  if (latest && RANK[outcome] <= RANK[latest]) return { action: 'propose', outcome, reason: `would not raise the recorded outcome (${latest})` };
  return { action: 'auto_record', outcome, reason: `${cls} reply via ${m.via}` };
}

const ADDRESS = /^[\w.+'-]+@[\w.-]+$/;

/** Gmail query for replies: never `in:inbox` (it hides archived/filtered mail). Newest sends first so the 20-term caps keep recent jobs;
 *  shared-domain recipients (gmail.com etc.) get an exact `from:<address>`; 60 days matches the stale sweep. `-in:sent` is also what
 *  keeps our own messages out of the results (the watcher does not filter by own address). */
export function buildReplyQuery(sent: SentEmail[], newerThanDays = 60): string {
  const newest = [...sent].sort((a, b) => b.sent_at.localeCompare(a.sent_at));
  const uniq = <T,>(xs: T[]) => [...new Set(xs)];
  const companies = uniq(newest.map((s) => (s.company ?? '').replace(/["{}]/g, '').trim()).filter(Boolean)).slice(0, 20).map((c) => `"${c}"`);
  const recipients = newest.map((s) => (s.email_to ?? '').trim().toLowerCase()).filter((a) => ADDRESS.test(a));
  const domains = uniq(recipients.map((a) => domainOf(a)).filter((d): d is string => !!d && !SHARED.has(d))).slice(0, 20);
  const addresses = uniq(recipients.filter((a) => SHARED.has(domainOf(a) ?? ''))).slice(0, 20);
  const terms = [...companies, ...[...domains, ...addresses, ...ATS_SENDERS].map((d) => `from:${d}`)];
  return `newer_than:${newerThanDays}d -in:sent -in:drafts {${terms.join(' ')}}`;
}
