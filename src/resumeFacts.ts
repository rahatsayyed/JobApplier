export interface FactCheckResult { verdict: 'pass' | 'block'; invented: string[] }

const YEAR = /^(19|20)\d{2}$/;
const METRIC = /\$?€?£?\d[\d,]*(?:\.\d+)?\s*(?:%|[kKmMbB]\b|x\b)?/g;

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach(x => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => strings(x, out));
  return out;
}
const norm = (s: unknown) =>
  String(s ?? '')
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

const tokens = (s: string): string[] => norm(s).replace(/\.js\b/g, '').split(/[^a-z0-9]+/).filter(Boolean);

function metrics(v: unknown): Set<string> {
  const found = new Set<string>();
  for (const text of strings(v)) {
    for (const m of text.matchAll(METRIC)) {
      const tok = m[0].toLowerCase().replace(/[\s,]/g, '');
      if (!tok || YEAR.test(tok)) continue;
      found.add(tok);
    }
  }
  return found;
}

function field(arr: any, key: string): Set<string> {
  return new Set((Array.isArray(arr) ? arr : []).map((x: any) => norm(x?.[key])).filter(Boolean));
}
function skillItems(r: any): string[] {
  return (r?.skills ?? []).flatMap((s: any) => (s?.items ?? []).map(norm)).filter(Boolean);
}

export function checkFacts(base: Record<string, any>, tailored: Record<string, any>): FactCheckResult {
  const invented: string[] = [];
  const baseMetrics = metrics(base);
  for (const m of metrics(tailored)) if (!baseMetrics.has(m)) invented.push(`metric:${m}`);

  for (const key of ['company', 'title', 'location', 'start', 'end'] as const) {
    const allowed = field(base.experience, key);
    for (const v of field(tailored.experience, key)) if (!allowed.has(v)) invented.push(`${key}:${v}`);
  }
  for (const key of ['degree', 'school', 'year'] as const) {
    const allowed = field(base.education, key);
    for (const v of field(tailored.education, key)) if (!allowed.has(v)) invented.push(`education-${key}:${v}`);
  }
  // Token pool: a tailored skill passes iff every word in it appears somewhere in the base skills.
  const pool = new Set(skillItems(base).flatMap(tokens));
  for (const s of new Set(skillItems(tailored))) {
    const t = tokens(s);
    if (!t.length || !t.every(w => pool.has(w))) invented.push(`skill:${s}`);
  }

  const contacts: Array<[string, unknown, unknown]> = [
    ['name', base.name, tailored.name], ['email', base.email, tailored.email],
    ['phone', base.phone, tailored.phone], ['website', base.website?.url, tailored.website?.url],
  ];
  for (const [k, b, t] of contacts) if (norm(t) && norm(t) !== norm(b)) invented.push(`contact:${k}`);

  return { verdict: invented.length ? 'block' : 'pass', invented };
}
