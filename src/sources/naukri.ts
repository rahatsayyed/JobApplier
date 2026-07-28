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
