import type { Job } from '../db.js';

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Builds a Naukri search-results URL from a role and optional location, matching Naukri's own
 * URL convention (e.g. https://www.naukri.com/full-stack-developer-jobs-in-india). Both segments
 * are slugified.
 */
export function buildNaukriSearchUrl(role: string, location?: string): string {
  const roleSlug = slugify(role);
  const locationSlug = location ? slugify(location) : '';
  const path = locationSlug ? `${roleSlug}-jobs-in-${locationSlug}` : `${roleSlug}-jobs`;
  return `https://www.naukri.com/${path}`;
}

/**
 * Extracts the trailing numeric id from a real Naukri job-listing URL (e.g.
 * `.../hyderabad-2-to-5-years-150426501261` -> `150426501261`), stripping any query string
 * first. Returns null if the URL has no trailing numeric segment.
 */
export function extractNaukriJobId(url: string): string | null {
  const withoutQuery = url.split('?')[0];
  const match = withoutQuery.match(/-(\d+)$/);
  return match ? match[1] : null;
}

export interface RawNaukriCard {
  titleText: string | null;
  companyText: string | null;
  hrefRaw: string | null;
  descriptionText: string | null;
}

export interface NaukriParseResult {
  jobs: Job[];
  found: number;
  parsed: number;
  skipped: number;
}

/**
 * Parses raw scraped card data into Job objects. A malformed card (missing title/href, or an
 * href with no extractable job id) is skipped and logged, never thrown — matches
 * `parseLinkedInJobCards`'s existing convention in `src/discover/linkedin-jobs.ts`.
 */
export function parseNaukriCards(rawCards: RawNaukriCard[]): NaukriParseResult {
  let parsed = 0;
  let skipped = 0;
  const jobs: Job[] = [];

  for (const card of rawCards) {
    try {
      if (!card.titleText || !card.hrefRaw) {
        throw new Error('missing title or href');
      }
      const jobId = extractNaukriJobId(card.hrefRaw);
      if (!jobId) {
        throw new Error('could not extract job id from href');
      }
      jobs.push({
        id: `naukri:${jobId}`,
        source: 'naukri',
        title: card.titleText.trim(),
        company: (card.companyText ?? '').trim(),
        url: card.hrefRaw,
        apply_url: card.hrefRaw,
        description: (card.descriptionText ?? '').trim(),
      });
      parsed++;
    } catch (err) {
      skipped++;
      console.error('[naukri] skipped malformed card:', err instanceof Error ? err.message : err);
    }
  }

  return { jobs, found: rawCards.length, parsed, skipped };
}
