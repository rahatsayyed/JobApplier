// Adapted from career-ops-hq/career-ops title-keywords.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama). See that repo's LICENSE.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostMatches } from '../../lib/hostClass.js';

export type Ats = 'greenhouse' | 'lever' | 'ashby';
export interface TrackedCompany { name: string; ats: Ats; slug: string; enabled: boolean; region?: 'eu' }
export interface PortalsConfig {
  tracked_companies: TrackedCompany[];
  title_filter: { positive: string[]; negative: string[] };
  location_filter: { allow: string[]; global: string[] };
}

const fold = (s: string) => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Cap applied by board fetchers to each plain-text description. */
export const MAX_DESCRIPTION_CHARS = 8000;

// ---- slugs and vendor URLs ----
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export function isValidSlug(s: unknown): s is string {
  return typeof s === 'string' && SLUG_RE.test(s) && s !== '.' && s !== '..';
}
export function assertSlug(s: string): void {
  if (!isValidSlug(s)) throw new Error(`invalid board slug ${JSON.stringify(s)}`);
}
/** Keep a response-supplied URL only if it is https and on the vendor's own domain; otherwise use the canonical one. */
export function safeVendorUrl(candidate: unknown, apex: string, fallback: string): string {
  return typeof candidate === 'string' && /^https:\/\//i.test(candidate) && hostMatches(candidate, apex) ? candidate : fallback;
}

// ---- title filter ----
// A "whole word" for word:/lead: also refuses a hyphenated compound continuation ("staff" vs "staff-augmentation").
const wordRe = (k: string) => new RegExp(`(?<![a-z0-9])${esc(k)}(?![a-z0-9]|-[a-z0-9])`);
// Lead segment = text before the first "(", ",", ":", "|" or spaced dash.
const leadSegment = (t: string) => t.split(/\s[-–—|]\s|[(,:|]/)[0].trim();

function keywordMatches(title: string, raw: string): boolean {
  const k = fold(raw).trim();
  if (!k) return false;
  if (k.startsWith('lead:')) { const w = k.slice(5).trim(); return !!w && wordRe(w).test(leadSegment(title)); }
  if (k.startsWith('word:')) { const w = k.slice(5).trim(); return !!w && wordRe(w).test(title); }
  if (k.startsWith('stem:')) { const w = k.slice(5).trim(); return !!w && new RegExp(`(?<![a-z0-9])${esc(w)}`).test(title); }
  if (k.length <= 3) return new RegExp(`(?<![a-z0-9])${esc(k)}(?![a-z0-9])`).test(title);
  return title.includes(k);
}

export function titlePasses(title: string, f: { positive: string[]; negative: string[] }): boolean {
  const t = fold(title);
  if (f.negative.some((n) => keywordMatches(t, n))) return false;
  const pos = f.positive.filter((p) => p.trim());
  if (!pos.length) return true;
  return pos.some((p) => p.split('+').map((x) => x.trim()).filter(Boolean).every((part) => keywordMatches(t, part)));
}

// ---- location filter: allow term, or a bare/global remote segment ----
const wordIn = (hay: string, term: string) => new RegExp(`(?<![a-z0-9])${esc(fold(term).trim())}(?![a-z0-9])`).test(hay);
const EXCLUDER = /(?<![a-z])(?:excl|excluding|except|outside)(?![a-z])/;
const FILLER = ['only', 'fully', 'based'];

function isBareGlobal(seg: string, globals: string[]): boolean {
  let rest = seg;
  for (const g of [...globals, ...FILLER].filter((x) => x.trim()).sort((a, b) => b.length - a.length)) {
    rest = rest.replace(new RegExp(`(?<![a-z0-9])${esc(fold(g).trim())}(?![a-z0-9])`, 'g'), ' ');
  }
  return rest.replace(/[^a-z0-9]+/g, '') === '';
}

export function locationAllowed(locations: string[], remote: boolean, f: { allow: string[]; global: string[] }): boolean {
  let segs = (locations.length ? locations : ['']).flatMap((l) => fold(l).split(';')).map((s) => s.trim()).filter(Boolean);
  if (!segs.length) segs = [''];
  for (const seg of segs) {
    if (EXCLUDER.test(seg)) continue;
    if (f.allow.some((a) => a.trim() && wordIn(seg, a))) return true;
    if (remote && isBareGlobal(seg, f.global)) return true;
  }
  return false;
}

// ---- HTML to text ----
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  mdash: '—', ndash: '–', hellip: '…', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™',
};
/** One regex pass: decodes numeric and the named entities above; unknown or invalid ones are left as written. */
function decodeOnce(s: string): string {
  return s.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z][a-z0-9]{1,15}));/gi, (m, d, h, n) => {
    if (d !== undefined || h !== undefined) {
      const cp = d !== undefined ? parseInt(d, 10) : parseInt(h, 16);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
    }
    const v = NAMED[String(n).toLowerCase()];
    return v === undefined ? m : v;
  });
}
const ESCAPED_TAG = /&lt;\/?[a-z](?:(?!&gt;)[\s\S])*&gt;/i;

/** Greenhouse `content` is escaped HTML: remove that escaping layer once, strip tags, then decode the text's entities once. */
export function htmlToPlain(s: string): string {
  let html = String(s ?? '');
  if (ESCAPED_TAG.test(html)) html = decodeOnce(html);
  return decodeOnce(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// ---- config ----
const defaultPath = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..'), 'config', 'portals.json');
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const DEFAULT_GLOBAL = ['remote', 'anywhere', 'worldwide', 'global'];

export function loadPortals(file: string = defaultPath): { config: PortalsConfig | null; error: string | null } {
  if (!existsSync(file)) return { config: null, error: null };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const tracked = (Array.isArray(raw?.tracked_companies) ? raw.tracked_companies : [])
      .filter((c: any) => c && typeof c.name === 'string' && typeof c.slug === 'string' && isValidSlug(c.slug.trim()) && ['greenhouse', 'lever', 'ashby'].includes(c.ats))
      .map((c: any) => ({ name: c.name, ats: c.ats as Ats, slug: c.slug.trim(), enabled: c.enabled === true, ...(c.region === 'eu' ? { region: 'eu' as const } : {}) }));
    return {
      config: {
        tracked_companies: tracked,
        title_filter: { positive: strs(raw?.title_filter?.positive), negative: strs(raw?.title_filter?.negative) },
        location_filter: {
          allow: strs(raw?.location_filter?.allow),
          global: Array.isArray(raw?.location_filter?.global) ? strs(raw.location_filter.global) : DEFAULT_GLOBAL,
        },
      },
      error: null,
    };
  } catch (e: any) {
    return { config: null, error: `config/portals.json: ${e?.message ?? e}` };
  }
}
