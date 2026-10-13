// Restriction markers: wording that limits who may take a role (residency, citizenship, right to work, "US only", exclusions).
// ONE list, imported by the board location filter (src/sources/boards/filters.ts) and by the veto backstops (src/vetoes.ts), so a posting
// cannot pass one gate and be refused by the other for different reasons. The text checked is untrusted posting text: it is capped at
// MAX_POLICY_TEXT characters and every pattern is linear (no nested quantifiers, bounded gaps).
//
// scope 'location': only checked in a location string ("Remote, US only", "US-based"); the same words in a long description are too noisy.
// scope 'any': also checked in the posting text (title + first MAX_POLICY_TEXT characters of the description).
// dir: where a target-region name cancels the marker ("must be located in the UAE", "UAE citizens only" are not restrictions for a target
// region): 'after' = the 30 characters after, 'before' = the 30 before, 'around' = both, 'none' = never cancelled ("excl. UAE" stays a restriction).

export const MAX_POLICY_TEXT = 20000;
const NEAR = 30;

type Dir = 'after' | 'before' | 'around' | 'none';
interface Marker { name: string; re: RegExp; scope: 'location' | 'any'; dir: Dir }

const W = '(?<![a-z0-9])';
const REGION = 'us|usa|u\\.s\\.a?|uk|eu|emea|canada|latam|europe|americas|north america|united states|united kingdom|germany|france|spain|poland|brazil|australia|singapore';
export const RESTRICTION_MARKERS: Marker[] = [
  { name: 'only', re: new RegExp(`${W}only(?![a-z0-9])`, 'g'), scope: 'location', dir: 'before' },
  { name: 'eligibility only', re: new RegExp(`${W}(?:residents?|citizens?|nationals?|candidates|applicants|hires?|time ?zones?)\\s+only(?![a-z0-9])`, 'g'), scope: 'any', dir: 'around' },
  { name: 'region only', re: new RegExp(`${W}(?:${REGION})\\s+only(?![a-z0-9])`, 'g'), scope: 'any', dir: 'around' },
  { name: 'must reside', re: new RegExp(`${W}must\\s+(?:reside|be\\s+located|live|be\\s+based|be\\s+(?:a\\s+)?resident)(?![a-z0-9])`, 'g'), scope: 'any', dir: 'after' },
  { name: 'based in', re: new RegExp(`${W}based\\s+in(?![a-z0-9])`, 'g'), scope: 'location', dir: 'after' },
  { name: '-based', re: /[a-z0-9]-based(?![a-z0-9])/g, scope: 'location', dir: 'before' },
  { name: 'residents of', re: new RegExp(`${W}residents?\\s+of(?![a-z0-9])`, 'g'), scope: 'any', dir: 'after' },
  { name: 'citizens', re: new RegExp(`${W}citizens?(?![a-z0-9])`, 'g'), scope: 'any', dir: 'around' },
  { name: 'right to work', re: new RegExp(`${W}right\\s+to\\s+work(?![a-z0-9])`, 'g'), scope: 'any', dir: 'around' },
  { name: 'work authorization', re: new RegExp(`${W}work\\s+authori[sz]ation(?![a-z0-9])`, 'g'), scope: 'any', dir: 'around' },
  { name: 'authorized to work', re: new RegExp(`${W}authori[sz]ed\\s+to\\s+work(?![a-z0-9])`, 'g'), scope: 'any', dir: 'around' },
  { name: 'eligible to work', re: new RegExp(`${W}eligible\\s+to\\s+work(?![a-z0-9])`, 'g'), scope: 'any', dir: 'around' },
  { name: 'visa required', re: new RegExp(`${W}visa\\s+required(?![a-z0-9])`, 'g'), scope: 'any', dir: 'around' },
  { name: 'no visa', re: new RegExp(`${W}no\\s+visa(?![a-z0-9])`, 'g'), scope: 'any', dir: 'around' },
  { name: 'relocation not', re: new RegExp(`${W}relocation\\s+(?:is\\s+)?not(?![a-z0-9])`, 'g'), scope: 'any', dir: 'around' },
  { name: 'excluding', re: new RegExp(`${W}(?:excl|excluding|except)(?![a-z])`, 'g'), scope: 'any', dir: 'none' },
  { name: 'not open to', re: new RegExp(`${W}not\\s+(?:open|available)\\s+(?:to|in)(?![a-z0-9])`, 'g'), scope: 'any', dir: 'none' },
  { name: 'outside india', re: new RegExp(`${W}(?:outside|other\\s+than)\\s+india(?![a-z0-9])`, 'g'), scope: 'any', dir: 'none' },
];

const fold = (s: string) => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Name of the first restriction marker in `text`, or null. `scope: 'location'` checks every marker (for a location string),
 * `'posting'` only the scope-'any' ones (for title + description). `targets` (specific target-region names) cancel a marker whose
 * subject is a target region (see `dir`), so "must be located in the UAE" is not a restriction but "must be located in London" is.
 */
export function findRestriction(text: string, opts: { scope: 'location' | 'posting'; targets?: string[] } = { scope: 'location' }): string | null {
  const hay = fold(String(text ?? '').slice(0, MAX_POLICY_TEXT));
  const terms = (opts.targets ?? []).filter((t) => t.trim()).map((t) => esc(fold(t).trim()));
  // The subject must be the very next words ("in the UAE") or the very previous ones ("UAE citizens"): a target name further away
  // ("must be located in London (Dubai office closed)") does not cancel the marker.
  const startsWithTarget = (s: string) => {
    const rest = s.replace(/^[\s,:;-]*(?:(?:in|within|of|at|to|the)\s+)*/, '');
    return terms.some((t) => new RegExp(`^${t}(?![a-z0-9])`).test(rest));
  };
  const endsWithTarget = (s: string) => terms.some((t) => new RegExp(`(?<![a-z0-9])${t}[\\s-]*(?:residents?|citizens?|nationals?|candidates|applicants|based)?[\\s-]*$`).test(s));
  for (const m of RESTRICTION_MARKERS) {
    if (opts.scope === 'posting' && m.scope === 'location') continue;
    for (const x of hay.matchAll(m.re)) {
      const at = x.index ?? 0;
      const after = hay.slice(at + x[0].length, at + x[0].length + NEAR);
      const before = hay.slice(Math.max(0, at - NEAR), at);
      const cancelled = ((m.dir === 'after' || m.dir === 'around') && startsWithTarget(after)) || ((m.dir === 'before' || m.dir === 'around') && endsWithTarget(before));
      if (!cancelled) return m.name;
    }
  }
  return null;
}
