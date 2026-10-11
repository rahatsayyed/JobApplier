// file: src/legitimacy.ts
// Deterministic legitimacy tier. Signals adapted from career-ops-hq/career-ops modes/oferta.md Block G (MIT, (c) 2026
// Santiago Fernandez de Valderrama) and providers/_trust-validator.mjs, plus India-specific job-scam patterns.
import { htmlToText } from './htmlText.js';

export interface LegitimacyInput {
  id: string; title: string; description: string | null;
  url?: string | null; apply_url?: string | null; repost_count?: number; age_days?: number | null;
  source?: string | null; snapshot_chars?: number;
}
export interface Legitimacy { tier: 'high' | 'caution' | 'suspicious'; signals: string[] }

const SHORTENER_HOSTS = ['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'forms.gle', 'shorturl.at', 'rebrand.ly', 'cutt.ly', 'wa.me', 'chat.whatsapp.com', 't.me'];
// These sources store a snippet or a location string, not the posting: a short description there is our scraper, not the employer.
const SNIPPET_SOURCES = new Set(['linkedin-jobs', 'naukri', 'adzuna']);
const FEE_RE = /\b(?:registration|security|training|processing|joining|refundable)\s+(?:fee|deposit|charges?)\b|\bpay\s+(?:a|the)\s+(?:fee|deposit)\b/gi;
// A fee only counts when it is not negated ("never charge a registration fee", "no security deposit"), the employer is not the one paying
// ("we pay the fee for your certification", "we reimburse the training fee"), and the clause shows the applicant as payer.
const NEGATION_RE = /\b(?:no|never|not|without|zero|nil|neither|nor)\b|\bfree of\b|n't\b/i;
const EMPLOYER_PAYS_RE = /\b(?:we|company|employer|they|us)\s+(?:will\s+|shall\s+)?(?:pay|pays|cover|covers|reimburse|sponsor|fund)\w*|\breimburs\w*|\bsponsor\w*|\bpaid by (?:us|the company|the employer)|\bcovered by\b/i;
const APPLICANT_PAYS_RE = /\b(?:you|candidates?|applicants?|selected|shortlisted|must|required|payable|pay|deposit of|fee of)\b|₹|\brs\.?\s*\d|\b(?:inr|usd)\b|\$\d/i;
function asksApplicantForFee(desc: string): boolean {
  for (const clause of desc.split(/[.!?;\n]+/)) {
    for (const m of clause.matchAll(FEE_RE)) {
      if (NEGATION_RE.test(clause.slice(Math.max(0, m.index! - 40), m.index!))) continue;
      if (EMPLOYER_PAYS_RE.test(clause)) continue;
      if (APPLICANT_PAYS_RE.test(clause)) return true;
    }
  }
  return false;
}
// "earn ... per day/week" is a pitch only with a currency amount; "earn a day off each week" is not.
const MONEY = String.raw`(?:(?:rs\.?|inr|₹|\$|usd)\s*\d[\d,.]*\s*(?:k|lakhs?|lpa)?|\d[\d,.]*\s*(?:k|lakhs?)?\s*(?:rs|inr|₹|\$|usd|rupees|dollars))`;
const EARN_RE = new RegExp(String.raw`\bearn\b[^.]{0,60}?${MONEY}[^.]{0,40}?\b(?:per|a|each|every)\s+(?:day|week)\b`, 'i');
const PERSONAL_CHANNEL_RE = /\b(?:send|share|whatsapp|forward)\b[^.]{0,40}\b(?:cv|resume)\b[^.]{0,30}\b(?:whatsapp|telegram)\b|\b(?:whatsapp|telegram)\b[^.]{0,30}\b(?:cv|resume)\b|\b[\w.+-]+@(?:gmail|yahoo|outlook|hotmail|rediffmail)\.(?:com|co\.in|in)\b/i;
const FIXED_TERM_RE = /\b\d+[\s-]*months?\s+contract\b|\bfixed[\s-]term\b|\btemporary\s+position\b|\bterm\s+position\b/i;

function hostOf(u: string | null | undefined): string | null {
  try { return u ? new URL(u).hostname.toLowerCase().replace(/^www\./, '') : null; } catch { return null; }
}
const isShortener = (u: string | null | undefined) => {
  const h = hostOf(u);
  return !!h && SHORTENER_HOSTS.some((s) => h === s || h.endsWith(`.${s}`));
};

export function assessLegitimacy(j: LegitimacyInput): Legitimacy {
  const desc = htmlToText(String(j.description ?? ''));
  const suspicious: string[] = [];
  const caution: string[] = [];
  const info: string[] = [];
  if (asksApplicantForFee(desc)) suspicious.push('asks the applicant for a fee or deposit');
  if (isShortener(j.apply_url) || isShortener(j.url)) suspicious.push('apply link is a URL shortener or chat/forms host');
  if (EARN_RE.test(desc)) suspicious.push('"earn per day/week" pay pitch');
  if ((j.repost_count ?? 0) >= 2) caution.push(`reposted ${j.repost_count} times in 90 days on the same board`);
  if (j.age_days != null && j.age_days > 60) caution.push(`posted ${j.age_days} days ago`);
  const chars = Math.max(desc.length, j.snapshot_chars ?? 0);
  const snippetSource = !!j.source && SNIPPET_SOURCES.has(j.source) && !(j.snapshot_chars && j.snapshot_chars > 0);
  if (!j.id.startsWith('li-post:') && !snippetSource && chars < 300) caution.push(`thin description (${chars} chars)`);
  if (!j.url && !j.apply_url) caution.push('no posting or apply URL');
  if (PERSONAL_CHANNEL_RE.test(desc)) caution.push('applications go to a personal mailbox or chat app');
  if (FIXED_TERM_RE.test(desc)) info.push('info: fixed-term contract');
  const tier = suspicious.length ? 'suspicious' : caution.length ? 'caution' : 'high';
  return { tier, signals: [...suspicious, ...caution, ...info] };
}
