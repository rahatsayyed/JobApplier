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

export function locationAllowed(locations: string[] | null | undefined, remote: boolean, f: { allow: string[]; global: string[] }): boolean {
  let segs = (Array.isArray(locations) && locations.length ? locations : ['']).flatMap((l) => fold(l).split(';')).map((s) => s.trim()).filter(Boolean);
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
const MAX_HTML_CHARS = 200000;
const MAX_TAG_CHARS = 2000;
const lowerAscii = (x: string) => x.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
const isLetter = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');

/** Linear check: is there an escaped tag ("&lt;" + letter or "/" ... "&gt;" within MAX_TAG_CHARS)? */
function hasEscapedTag(h: string): boolean {
  let gt = -2; // cached position of the next "&gt;" at or after the scan point
  let i = h.indexOf('&lt;');
  while (i !== -1) {
    const c = h[i + 4] ?? '';
    if (isLetter(c) || c === '/') {
      if (gt < i) { gt = h.indexOf('&gt;', i); if (gt === -1) return false; }
      if (gt - i <= MAX_TAG_CHARS) return true;
    }
    i = h.indexOf('&lt;', i + 4);
  }
  return false;
}

/** Single-pass tag stripper. A "<" opens a tag only before a letter, "/", "!" or "?" and a ">" within MAX_TAG_CHARS; script/style content is dropped. */
function stripTags(h: string): string {
  const low = lowerAscii(h);
  let out = '';
  let gt = -2;
  let noGt = false; // once no ">" exists after some position, none exists after any later one: cache that so unmatched "<" runs stay linear
  let i = 0;
  while (i < h.length) {
    const c = h[i];
    if (c !== '<') { out += c; i++; continue; }
    const n = h[i + 1] ?? '';
    if (!(isLetter(n) || n === '/' || n === '!' || n === '?')) { out += c; i++; continue; }
    if (noGt) { out += c; i++; continue; }
    if (gt < i) { gt = h.indexOf('>', i); if (gt === -1) { noGt = true; out += c; i++; continue; } }
    if (gt - i > MAX_TAG_CHARS) { out += c; i++; continue; }
    const m = /^<(script|style)(?![a-z0-9])/.exec(low.slice(i, i + 10));
    if (m) {
      const close = low.indexOf(`</${m[1]}`, gt + 1);
      if (close === -1) { out += ' '; break; }
      const end = low.indexOf('>', close);
      out += ' ';
      i = end === -1 ? h.length : end + 1;
      continue;
    }
    out += ' ';
    i = gt + 1;
  }
  return out;
}

/** Greenhouse `content` is escaped HTML: remove that escaping layer once, strip tags, then decode the text's entities once. Linear time. */
export function htmlToPlain(s: string): string {
  let html = String(s ?? '').slice(0, MAX_HTML_CHARS);
  if (hasEscapedTag(html)) html = decodeOnce(html);
  return decodeOnce(stripTags(html)).replace(/\s+/g, ' ').trim();
}

// ---- config ----
const defaultPath = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..'), 'config', 'portals.json');
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const DEFAULT_GLOBAL = ['remote', 'anywhere', 'worldwide', 'global'];

/** `warnings` has one string per dropped invalid tracked_companies entry (present only when a config was parsed). */
export function loadPortals(file: string = defaultPath): { config: PortalsConfig | null; error: string | null; warnings?: string[] } {
  if (!existsSync(file)) return { config: null, error: null };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const bad = (why: string) => ({ config: null, error: `config/portals.json: ${why}` });
    const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
    if (!isObj(raw)) return bad('top level must be an object');
    if (!Array.isArray(raw.tracked_companies)) return bad('tracked_companies must be an array');
    if (!isObj(raw.title_filter) || !Array.isArray(raw.title_filter.positive) || !Array.isArray(raw.title_filter.negative)) return bad('title_filter.positive and title_filter.negative must be arrays');
    if (!strs(raw.title_filter.positive).some((x) => x.trim())) return bad('title_filter.positive must not be empty');
    if (!isObj(raw.location_filter) || !Array.isArray(raw.location_filter.allow)) return bad('location_filter.allow must be an array');
    if (!strs(raw.location_filter.allow).some((x) => x.trim())) return bad('location_filter.allow must not be empty');
    if (raw.location_filter.global !== undefined && !Array.isArray(raw.location_filter.global)) return bad('location_filter.global must be an array');
    const warnings: string[] = [];
    const tracked = (Array.isArray(raw?.tracked_companies) ? raw.tracked_companies : [])
      .filter((c: any, i: number) => {
        const label = `config/portals.json: tracked_companies[${i}]${c && typeof c.name === 'string' ? ` (${c.name.slice(0, 60)})` : ''} skipped`;
        if (!c || typeof c.name !== 'string') { warnings.push(`${label}: missing name`); return false; }
        if (!['greenhouse', 'lever', 'ashby'].includes(c.ats)) { warnings.push(`${label}: unknown ats ${JSON.stringify(c.ats)}`); return false; }
        if (typeof c.slug !== 'string' || !isValidSlug(c.slug.trim())) { warnings.push(`${label}: invalid slug`); return false; }
        return true;
      })
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
      warnings,
    };
  } catch (e: any) {
    return { config: null, error: `config/portals.json: ${e?.message ?? e}` };
  }
}
