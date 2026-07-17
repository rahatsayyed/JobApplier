import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Job } from '../db.js';

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
