import type { Job } from '../db.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb, isSeen, saveJob } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');
const DEFAULT_SESSION_STATE_PATH = path.join(projectRoot, 'secrets', 'naukri-state.json');
const CARD_SELECTOR = '.srp-jobtuple-wrapper';
const COMPANY_SITE_BUTTON_SELECTOR = '.company-site-button';

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

export interface NaukriDeps {
  /** Injectable Playwright `chromium` launcher, for testing without a real browser. */
  chromium?: { launch: typeof chromium.launch };
  /** Injectable db handle, for testing without touching data.sqlite. */
  db?: BetterSqlite3.Database;
  /** Injectable session-state file path, for testing without touching the real secrets file. */
  sessionStatePath?: string;
}

/**
 * Clicks Naukri's "Apply on company site" button if present and returns the resulting new tab's
 * URL — navigation only, never a submission. Returns null if the button isn't present, or if
 * waiting for the new tab times out.
 */
export async function resolveApplyUrl(
  page: Pick<Page, 'locator'>,
  context: Pick<BrowserContext, 'waitForEvent'>
): Promise<string | null> {
  const button = page.locator(COMPANY_SITE_BUTTON_SELECTOR).first();
  if ((await button.count()) === 0) return null;

  try {
    const [newPage] = await Promise.all([context.waitForEvent('page', { timeout: 10000 }), button.click()]);
    await newPage.waitForLoadState('domcontentloaded').catch(() => {});
    const url = newPage.url();
    await newPage.close().catch(() => {});
    return url;
  } catch {
    return null;
  }
}

/**
 * Scrapes Naukri's search-results page for a role/location, then (if a saved session exists)
 * resolves each new job's real apply_url via `resolveApplyUrl`. Both phases run `headless: false`
 * — Naukri's Akamai bot protection blocks headless Chromium outright (see Global Constraints).
 */
export async function fetchNaukriJobs(
  params: { role: string; location?: string },
  deps: NaukriDeps = {}
): Promise<Job[]> {
  const db = deps.db ?? openDb('data.sqlite');
  const browserLauncher = deps.chromium ?? chromium;
  const sessionStatePath = deps.sessionStatePath ?? DEFAULT_SESSION_STATE_PATH;
  const searchUrl = buildNaukriSearchUrl(params.role, params.location);

  let browser: Browser | undefined;
  try {
    browser = await browserLauncher.launch({ headless: false });

    let newJobs: Job[] = [];
    const searchContext = await browser.newContext();
    try {
      const page = await searchContext.newPage();
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(CARD_SELECTOR, { timeout: 15000 });

      const rawCards: RawNaukriCard[] = await page.locator(CARD_SELECTOR).evaluateAll((nodes: Element[]) =>
        nodes.map((n) => {
          const titleEl = n.querySelector('a.title') as HTMLAnchorElement | null;
          const companyEl = n.querySelector('.comp-name');
          const descEl = n.querySelector('.job-desc');
          return {
            titleText: titleEl?.textContent ?? null,
            companyText: companyEl?.textContent ?? null,
            hrefRaw: titleEl?.href ?? null,
            descriptionText: descEl?.textContent ?? null,
          };
        })
      );

      const { jobs, found, parsed, skipped } = parseNaukriCards(rawCards);
      console.error(`[naukri] ${parsed}/${found} parsed, ${skipped} skipped (malformed)`);
      newJobs = jobs.filter((job) => !isSeen(db, job.id));
    } catch (err) {
      console.error('[naukri] search fetch failed:', err instanceof Error ? err.message : err);
      return [];
    } finally {
      await searchContext.close();
    }

    if (newJobs.length > 0 && existsSync(sessionStatePath)) {
      const applyContext = await browser.newContext({ storageState: sessionStatePath });
      try {
        for (const job of newJobs) {
          try {
            const page = await applyContext.newPage();
            await page.goto(job.url, { waitUntil: 'domcontentloaded' });
            const resolvedUrl = await resolveApplyUrl(page, applyContext);
            if (resolvedUrl) job.apply_url = resolvedUrl;
            await page.close();
          } catch (err) {
            console.error(`[naukri] resolveApplyUrl failed for ${job.id}:`, err instanceof Error ? err.message : err);
          }
        }
      } finally {
        await applyContext.close();
      }
    } else if (newJobs.length > 0) {
      console.error(
        `[naukri] session state not found at ${sessionStatePath} — using Naukri listing URLs as apply_url`
      );
    }

    for (const job of newJobs) {
      saveJob(db, job);
    }
    return newJobs;
  } catch (err) {
    console.error('[naukri] fetch failed:', err instanceof Error ? err.message : err);
    return [];
  } finally {
    await browser?.close();
  }
}
