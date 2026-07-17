import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb, isSeen, saveJob, type Job } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

const CONFIG_PATH = path.join(projectRoot, 'config', 'discover-linkedin.json');

export interface DiscoverLinkedInConfig {
  jobs: { search_url: string; limit: number };
  posts: { role: string; geo: string; limit: number };
}

export function loadDiscoverConfig(): DiscoverLinkedInConfig {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

export interface RawJobCard {
  titleText: string | null;
  companyText: string | null;
  hrefRaw: string | null;
  snippetText: string | null;
  easyApply: boolean;
}

export interface ParseResult {
  jobs: Job[];
  found: number;
  parsed: number;
  skipped: number;
}

export function extractLinkedInJobId(href: string): string | null {
  const match = href.match(/\/jobs\/view\/(\d+)/);
  return match ? match[1] : null;
}

export function parseLinkedInJobCards(rawCards: RawJobCard[]): ParseResult {
  let parsed = 0;
  let skipped = 0;
  const jobs: Job[] = [];

  for (const card of rawCards) {
    try {
      if (!card.titleText || !card.hrefRaw) {
        throw new Error('missing title or href');
      }
      const jobId = extractLinkedInJobId(card.hrefRaw);
      if (!jobId) {
        throw new Error('could not extract job id from href');
      }
      jobs.push({
        id: `li-job:${jobId}`,
        source: 'linkedin-jobs',
        title: card.titleText.trim(),
        company: (card.companyText ?? '').trim(),
        url: card.hrefRaw,
        apply_url: card.hrefRaw,
        description: (card.snippetText ?? '').trim(),
      });
      parsed++;
    } catch (err) {
      skipped++;
      console.error(
        '[discover] linkedin_jobs: skipped malformed card:',
        err instanceof Error ? err.message : err
      );
    }
  }

  return { jobs, found: rawCards.length, parsed, skipped };
}

const BURNER_STATE_PATH = path.join(projectRoot, 'secrets', 'linkedin-burner-state.json');

export interface LinkedInJobsDeps {
  /** Injectable Playwright `chromium` launcher, for testing without a real browser. */
  chromium?: { launch: typeof chromium.launch };
  /** Injectable db handle, for testing without touching data.sqlite. */
  db?: BetterSqlite3.Database;
  /** Injectable config, for testing without touching config/discover-linkedin.json. */
  configOverride?: DiscoverLinkedInConfig;
}

const JOB_CARD_SELECTOR = '.job-card-container, .jobs-search-results__list-item';

export async function fetchLinkedInJobs(deps: LinkedInJobsDeps = {}): Promise<Job[]> {
  const config = deps.configOverride ?? loadDiscoverConfig();
  const db = deps.db ?? openDb('data.sqlite');
  const browserLauncher = deps.chromium ?? chromium;

  let browser: Browser | undefined;
  try {
    browser = await browserLauncher.launch({ headless: true });
    const context = await browser.newContext({ storageState: BURNER_STATE_PATH });
    const page = await context.newPage();
    await page.goto(config.jobs.search_url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(JOB_CARD_SELECTOR, { timeout: 15000 });

    const rawCards: RawJobCard[] = await page.locator(JOB_CARD_SELECTOR).evaluateAll((nodes: Element[]) =>
      nodes.map((n) => {
        const titleEl = n.querySelector('a.job-card-list__title, .job-card-container__link') as HTMLAnchorElement | null;
        const companyEl = n.querySelector('.job-card-container__primary-description, .artdeco-entity-lockup__subtitle');
        const snippetEl = n.querySelector('.job-card-list__insight, .job-card-container__metadata-wrapper');
        return {
          titleText: titleEl?.textContent ?? null,
          companyText: companyEl?.textContent ?? null,
          hrefRaw: titleEl?.href ?? null,
          snippetText: snippetEl?.textContent ?? null,
          easyApply: !!n.querySelector('[aria-label*="Easy Apply" i]'),
        };
      })
    );

    const capped = rawCards.slice(0, config.jobs.limit);
    const { jobs, found, parsed, skipped } = parseLinkedInJobCards(capped);
    console.error(`[discover] linkedin_jobs: ${parsed}/${found} parsed, ${skipped} skipped (malformed)`);

    const newJobs = jobs.filter((job) => !isSeen(db, job.id));
    for (const job of newJobs) {
      saveJob(db, job);
    }
    return newJobs;
  } catch (err) {
    console.error('[discover] linkedin_jobs: fetch failed:', err instanceof Error ? err.message : err);
    return [];
  } finally {
    await browser?.close();
  }
}
