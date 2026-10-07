export type Liveness = 'active' | 'expired' | 'uncertain';

const ANTI_BOT = /just a moment|cloudflare|verify you are human|captcha/;
const HARD_EXPIRED = [/no longer available/, /has expired/, /no longer accepting/, /this (?:role|job|position) is closed(?!-)/, /has been filled/, /job (?:is )?no longer exists/];
const CONDITIONAL = /\b(until|once|when|if|unless)\b(?:\W+\w+){0,10}\W+$/;
const APPLY = /\bapply( now| for this job)?\b|easy apply/;
const JOB_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{5,}/i;

const clean = (s: string) => s.normalize('NFD').replace(/\p{Mn}/gu, '').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').toLowerCase();

export function classifyLiveness(i: { status: number; requestedUrl: string; finalUrl: string; bodyText: string }): Liveness {
  const text = clean(i.bodyText);
  if (i.status === 404 || i.status === 410) return 'expired';
  if (ANTI_BOT.test(text) || [403, 429, 503].includes(i.status) || i.status >= 500) return 'uncertain';
  if (/[?&]error=true/.test(i.finalUrl)) return 'expired';
  for (const re of HARD_EXPIRED) {
    const m = re.exec(text);
    if (m && !CONDITIONAL.test(text.slice(0, m.index))) return 'expired';
  }
  const id = JOB_ID.exec(i.requestedUrl)?.[0];
  if (id && !i.finalUrl.includes(id)) return 'uncertain';
  if (APPLY.test(text)) return 'active';
  if (text.length < 300) return 'expired';
  return 'uncertain';
}

export async function checkLiveness(url: string): Promise<Liveness> {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10_000) });
    return classifyLiveness({ status: res.status, requestedUrl: url, finalUrl: res.url, bodyText: await res.text() });
  } catch {
    return 'uncertain';
  }
}
