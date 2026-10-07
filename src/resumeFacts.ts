export interface FactCheckResult { verdict: 'pass' | 'block'; invented: string[] }

const YEAR = /^(19|20)\d{2}$/;
const METRIC = /\$?€?£?\d[\d,]*(?:\.\d+)?\s*(?:%|[kKmMbB]\b|x\b)?/g;

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach(x => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => strings(x, out));
  return out;
}
const norm = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

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
function skillItems(r: any): Set<string> {
  return new Set((r?.skills ?? []).flatMap((s: any) => (s?.items ?? []).map(norm)));
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
  const allowedSkills = skillItems(base);
  for (const s of skillItems(tailored)) if (!allowedSkills.has(s)) invented.push(`skill:${s}`);

  return { verdict: invented.length ? 'block' : 'pass', invented };
}
