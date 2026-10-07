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
  return 'uncertain';
}

/** True only for http(s) URLs whose host is not localhost / private / link-local / internal. */
export function isSafeFetchUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (host.startsWith('[')) {
    const v6 = host.slice(1, -1);
    return !(v6 === '::1' || v6 === '::' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('::ffff:'));
  }
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
  }
  return true;
}

export async function checkLiveness(url: string): Promise<Liveness> {
  if (!isSafeFetchUrl(url)) return 'uncertain';
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10_000) });
    return classifyLiveness({ status: res.status, requestedUrl: url, finalUrl: res.url, bodyText: await res.text() });
  } catch {
    return 'uncertain';
  }
}
