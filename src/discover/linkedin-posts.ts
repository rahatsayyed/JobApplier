import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb, isSeen, saveJob, type Job } from '../db.js';
import { loadDiscoverConfig, type DiscoverLinkedInConfig, type ParseResult } from './linkedin-jobs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const BURNER_STATE_PATH = path.join(projectRoot, 'secrets', 'linkedin-burner-state.json');

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
  const keywords = `(hiring OR "we're hiring" OR "we are hiring" OR "join our team") (${role}) ${geo}`;
  const params = new URLSearchParams({
    keywords,
    origin: 'GLOBAL_SEARCH_HEADER',
    sortBy: '"date_posted"',
  });
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

export interface LinkedInPostsDeps {
  /** Injectable Playwright `chromium` launcher, for testing without a real browser. */
  chromium?: { launch: typeof chromium.launch };
  /** Injectable db handle, for testing without touching data.sqlite. */
  db?: BetterSqlite3.Database;
  /** Injectable config, for testing without touching config/discover-linkedin.json. */
  configOverride?: DiscoverLinkedInConfig;
  /** Injectable burner session state path, for testing without touching the real secrets file. */
  burnerStatePath?: string;
}

const POST_CARD_SELECTOR = '.feed-shared-update-v2, .reusable-search__result-container';

export async function fetchLinkedInPosts(
  params: { role?: string; geo?: string },
  deps: LinkedInPostsDeps = {}
): Promise<Job[]> {
  const config = deps.configOverride ?? loadDiscoverConfig();
  const role = params.role ?? config.posts.role;
  const geo = params.geo ?? config.posts.geo;
  const db = deps.db ?? openDb('data.sqlite');
  const browserLauncher = deps.chromium ?? chromium;
  const burnerStatePath = deps.burnerStatePath ?? BURNER_STATE_PATH;

  if (!existsSync(burnerStatePath)) {
    console.error(`[discover] linkedin_posts: burner session state not found at ${burnerStatePath}`);
    return [];
  }

  let browser: Browser | undefined;
  try {
    browser = await browserLauncher.launch({ headless: true });
    const context = await browser.newContext({ storageState: burnerStatePath });
    const page = await context.newPage();
    const searchUrl = buildLinkedInPostSearchUrl(role, geo);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(POST_CARD_SELECTOR, { timeout: 15000 });

    const rawCards: RawPostCard[] = await page.locator(POST_CARD_SELECTOR).evaluateAll((nodes: Element[]) =>
      nodes.map((n) => {
        const textEl = n.querySelector('.feed-shared-update-v2__description, .update-components-text');
        const linkEl = n.querySelector('a[href*="urn:li:activity"]') as HTMLAnchorElement | null;
        const authorEl = n.querySelector('.update-components-actor__name, .entity-result__title-text');
        return {
          textContent: textEl?.textContent ?? null,
          hrefRaw: linkEl?.href ?? null,
          authorText: authorEl?.textContent ?? null,
        };
      })
    );

    const capped = rawCards.slice(0, config.posts.limit);
    const { jobs, found, parsed, skipped } = parseLinkedInPostCards(capped);
    console.error(`[discover] linkedin_posts: ${parsed}/${found} parsed, ${skipped} skipped (malformed)`);

    const newJobs = jobs.filter((job) => !isSeen(db, job.id));
    for (const job of newJobs) {
      saveJob(db, job);
    }
    return newJobs;
  } catch (err) {
    console.error('[discover] linkedin_posts: fetch failed:', err instanceof Error ? err.message : err);
    return [];
  } finally {
    await browser?.close();
  }
}
