import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { delegatedAuthorshipClaims, diagnoseCoverage, exceedsScanCap, factClaims, joinStatements, MAX_SCAN_CHARS, metricClaims, normalizeClaim, normalizeFact, sourceContainsFact } from './factClaims.js';
import { proseFindings, resumeStatements } from './proseClaims.js';

export interface FactCheckResult { verdict: 'pass' | 'block'; invented: string[] }

const YEAR = /^(19|20)\d{2}$/;
const METRIC = /\$?€?£?\d[\d,]*(?:\.\d+)?\s*(?:%|[kKmMbB]\b|x\b)?/g;

export function strings(v: unknown, out: string[] = []): string[] {
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

// ---------- v2: full fact gate (v1 checks + claim extractors + prose checks + config) ----------
export interface FactGateConfig { allow_metrics: string[]; allow_facts: string[]; forbidden_phrases: string[]; warn_phrases: string[] }
export const EMPTY_FACT_GATE: FactGateConfig = { allow_metrics: [], allow_facts: [], forbidden_phrases: [], warn_phrases: [] };
const defaultFactGatePath = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'config', 'fact-gate.json');

/** Read fresh on every call (like easy-apply-answers.json). Missing file = reported, invalid file = throws (fail closed). */
export function loadFactGateConfig(file: string = defaultFactGatePath): { config: FactGateConfig; missing: boolean } {
  if (!existsSync(file)) return { config: { ...EMPTY_FACT_GATE }, missing: true };
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const config: FactGateConfig = { ...EMPTY_FACT_GATE };
  for (const k of Object.keys(EMPTY_FACT_GATE) as Array<keyof FactGateConfig>) {
    const v = raw?.[k];
    if (v == null) continue;
    if (!Array.isArray(v) || !v.every((x: unknown) => typeof x === 'string')) throw new Error(`config/fact-gate.json: ${k} must be an array of strings`);
    config[k] = v;
  }
  return { config, missing: false };
}

export interface FactReport {
  verdict: 'pass' | 'warn' | 'block';
  invented: string[];
  unsupported: string[];
  forbidden: string[];
  warnings: string[];
  configMissing: boolean;
}
export interface CheckOptions { jobDescription?: string; jobTitle?: string; company?: string; config?: FactGateConfig; configMissing?: boolean }

const uniq = (xs: string[]) => [...new Set(xs)];
function phraseHits(text: string, phrases: string[]): string[] {
  const t = norm(text);
  return uniq(phrases.map((p) => p.trim()).filter(Boolean).filter((p) => t.includes(norm(p))));
}
function allowedMetricSet(sourceText: string, allow: string[]): Set<string> {
  const s = new Set(metricClaims(sourceText));
  for (const e of allow) {
    s.add(normalizeClaim(e));
    metricClaims(e).forEach((x) => s.add(x));
  }
  return s;
}
/** Replace each phrase (the posting title, the company) with a space so quoting it is not read as a claim. */
function blankOut(text: string, phrases: Array<string | undefined>): string {
  let out = text;
  for (const p of phrases) {
    const t = (p ?? '').trim();
    if (t.length < 3) continue;
    out = out.replace(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'gi'), ' ');
  }
  return out;
}
function resolveConfig(opts: CheckOptions): { config: FactGateConfig; missing: boolean } {
  return opts.config ? { config: opts.config, missing: !!opts.configMissing } : loadFactGateConfig();
}
function finish(invented: string[], unsupported: string[], forbidden: string[], warnings: string[], missing: boolean): FactReport {
  if (missing) warnings.push('config: config/fact-gate.json not found; allow-lists and phrase checks did not run');
  const verdict = invented.length || unsupported.length || forbidden.length ? 'block' : warnings.length ? 'warn' : 'pass';
  return { verdict, invented: uniq(invented), unsupported: uniq(unsupported), forbidden: uniq(forbidden), warnings: uniq(warnings), configMissing: missing };
}

// Extractors silently cap input at MAX_SCAN_CHARS, so the gate refuses oversize fields instead of truncating.
function oversizeBlock(fields: Record<string, string>, missing: boolean): FactReport | null {
  const bad = Object.entries(fields).filter(([, t]) => exceedsScanCap(t)).map(([k]) => `oversize: ${k} exceeds ${MAX_SCAN_CHARS} chars; not fact-checked`);
  return bad.length ? finish([], bad, [], [], missing) : null;
}

/** The resume gate used by render_resume. v1 checkFacts stays as-is; this adds everything v2 checks. */
export function checkResume(base: Record<string, any>, tailored: Record<string, any>, opts: CheckOptions = {}): FactReport {
  const { config, missing } = resolveConfig(opts);
  const baseText = joinStatements(strings(base));
  const baseProse = joinStatements(resumeStatements(base).map((s) => s.text));
  const prose = joinStatements(resumeStatements(tailored).map((s) => s.text));
  const tailoredText = joinStatements(strings(tailored));
  const over = oversizeBlock({ 'tailored resume': prose, 'tailored resume text': tailoredText, 'base resume': baseText, 'base resume prose': baseProse }, missing);
  if (over) return over;
  const allowedMetrics = allowedMetricSet(baseText, config.allow_metrics);
  const allowFacts = new Set(config.allow_facts.map(normalizeFact));

  const invented = checkFacts(base, tailored).invented.filter((x) => !(x.startsWith('metric:') && allowedMetrics.has(normalizeClaim(x.slice(7)))));
  for (const c of metricClaims(tailoredText)) if (c.includes(' ') && !allowedMetrics.has(c)) invented.push(`count:${c}`);

  const sourceNorm = normalizeFact(baseText);
  const unsupported: string[] = [];
  for (const c of [...factClaims(prose, sourceNorm), ...delegatedAuthorshipClaims(prose, baseProse)]) {
    if (!sourceContainsFact(sourceNorm, c.value) && !allowFacts.has(c.value)) unsupported.push(`${c.kind}:${c.value}`);
  }
  const warnings: string[] = [];
  for (const f of proseFindings(base, tailored, { jobDescription: opts.jobDescription, jobTitle: opts.jobTitle })) {
    if (allowFacts.has(normalizeFact(f.match))) continue;
    (f.severity === 'block' ? unsupported : warnings).push(`${f.kind}:${f.value} @${f.where}`);
  }
  const forbidden = phraseHits(prose, config.forbidden_phrases);
  const baseWarn = new Set(phraseHits(baseProse, config.warn_phrases));
  for (const p of phraseHits(prose, config.warn_phrases)) if (!baseWarn.has(p)) warnings.push(`phrase:${p}`);
  const cov = diagnoseCoverage(prose);
  if (cov) warnings.push(`coverage:${cov}`);
  return finish(invented, unsupported, forbidden, warnings, missing);
}

/** Gate for drafted emails / connect notes / follow-ups. `extraSource` adds text the claims may also come from (e.g. the original sent email).
 *  `jobTitle` and `company` are blanked out of the text first: naming the posting or the employer is not a claim. */
export function checkOutreachText(text: string, base: Record<string, any>, opts: CheckOptions & { extraSource?: string } = {}): FactReport {
  const { config, missing } = resolveConfig(opts);
  const clean = blankOut(String(text ?? '').replace(/https?:\/\/\S+/g, ' '), [opts.jobTitle, opts.company]);
  const baseText = joinStatements([...strings(base), opts.extraSource ?? '']);
  const over = oversizeBlock({ 'outreach text': clean, 'base resume': baseText }, missing);
  if (over) return over;
  const allowedMetrics = allowedMetricSet(baseText, config.allow_metrics);
  const allowFacts = new Set(config.allow_facts.map(normalizeFact));
  const invented = [...metricClaims(clean)].filter((c) => !allowedMetrics.has(c)).map((c) => `metric:${c}`);
  const sourceNorm = normalizeFact(baseText);
  const unsupported: string[] = [];
  for (const c of [...factClaims(clean, sourceNorm), ...delegatedAuthorshipClaims(clean, baseText)]) {
    if (!sourceContainsFact(sourceNorm, c.value) && !allowFacts.has(c.value)) unsupported.push(`${c.kind}:${c.value}`);
  }
  const warnings: string[] = [];
  const pseudo = { summary: clean.replace(/\s*\n+\s*/g, ' ') };
  for (const f of proseFindings(base, pseudo, { jobDescription: opts.jobDescription })) {
    if (f.kind === 'headline' || f.kind === 'posting-echo') continue; // an email may quote the role title and the posting
    if (allowFacts.has(normalizeFact(f.match))) continue;
    (f.severity === 'block' ? unsupported : warnings).push(`${f.kind}:${f.value}`);
  }
  const forbidden = phraseHits(clean, config.forbidden_phrases);
  for (const p of phraseHits(clean, config.warn_phrases)) warnings.push(`phrase:${p}`);
  return finish(invented, unsupported, forbidden, warnings, missing);
}
