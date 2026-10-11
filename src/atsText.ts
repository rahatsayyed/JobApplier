// file: src/atsText.ts
// ATS-safe text normalization, shared by the fact gate and the renderer so the gate always checks exactly the text
// that is rendered or sent. Pure, no I/O.

const FORMAT_CHARS = /\p{Cf}/gu; // soft hyphen, zero-width chars, bidi controls, word joiners, BOM, ...

/** ATS-safe text: some importers drop non-ASCII dashes in date ranges (ai-job-search verify_pdf origin story).
 *  Invisible format characters are stripped so "Kuber​netes" cannot slip past the fact gate and render as "Kubernetes". */
export function normalizeText(s: string): string {
  return s
    .replace(FORMAT_CHARS, '')
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[  ]/g, ' ')
    .replace(/\s*→\s*/g, ' to ');
}

/** normalizeText applied to every string in a JSON value (returns a new value; the input is not mutated). */
export function normalizeForAts<T>(v: T): T {
  const walk = (x: any): any => (typeof x === 'string' ? normalizeText(x) : Array.isArray(x) ? x.map(walk) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, val]) => [k, walk(val)])) : x);
  return walk(v);
}
