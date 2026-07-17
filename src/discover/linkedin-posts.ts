import type { Job } from '../db.js';
import { loadDiscoverConfig, type DiscoverLinkedInConfig, type ParseResult } from './linkedin-jobs.js';

export { loadDiscoverConfig };
export type { DiscoverLinkedInConfig, ParseResult };

export interface RawPostCard {
  textContent: string | null;
  hrefRaw: string | null;
  authorText: string | null;
}

export function extractActivityUrn(href: string): string | null {
  const match = href.match(/urn:li:activity:(\d+)/);
  return match ? match[1] : null;
}

const HIRING_KEYWORDS = /\b(hiring|we're hiring|we are hiring|join our team|open position|looking for)\b/i;

export function isHiringIntent(text: string): boolean {
  return HIRING_KEYWORDS.test(text);
}

export function buildLinkedInPostSearchUrl(role: string, geo: string): string {
  const keywords = `(hiring OR "we're hiring" OR "we are hiring" OR "join our team") (${role})`;
  const params = new URLSearchParams({
    keywords,
    origin: 'GLOBAL_SEARCH_HEADER',
    sortBy: '"date_posted"',
  });
  void geo; // geo is not part of LinkedIn's content-search URL today; kept as a param for parity with fetchLinkedInPosts and future use
  return `https://www.linkedin.com/search/results/content/?${params.toString()}`;
}

export function parseLinkedInPostCards(rawCards: RawPostCard[]): ParseResult {
  let parsed = 0;
  let skipped = 0;
  const jobs: Job[] = [];

  for (const card of rawCards) {
    try {
      if (!card.textContent || !card.hrefRaw) {
        throw new Error('missing text or href');
      }
      const urn = extractActivityUrn(card.hrefRaw);
      if (!urn) {
        throw new Error('could not extract activity urn from href');
      }
      if (!isHiringIntent(card.textContent)) {
        continue; // not malformed, just not a hiring post — silently excluded, not counted as skipped
      }
      jobs.push({
        id: `li-post:${urn}`,
        source: 'linkedin-posts',
        title: (card.authorText ?? 'LinkedIn hiring post').trim(),
        company: '',
        url: card.hrefRaw,
        apply_url: card.hrefRaw,
        description: card.textContent.trim(),
      });
      parsed++;
    } catch (err) {
      skipped++;
      console.error(
        '[discover] linkedin_posts: skipped malformed card:',
        err instanceof Error ? err.message : err
      );
    }
  }

  return { jobs, found: rawCards.length, parsed, skipped };
}
