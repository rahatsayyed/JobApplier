import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { chromium } from 'playwright';
import BetterSqlite3 from 'better-sqlite3';
import { openDb, getJob, saveApplication } from '../db.js';
import { getBaseResume } from '../resume.js';
import { checkAndIncrement } from '../lib/rateLimit.js';
import type { FieldMap } from '../ats/types.js';
import * as greenhouse from '../ats/greenhouse.js';
import * as lever from '../ats/lever.js';
import * as workday from '../ats/workday.js';
import * as ashby from '../ats/ashby.js';

// Must match linkedin-apply.ts's own DEFAULT_MAX_APPLIES_PER_DAY — see the shared-counter
// rationale on the `checkAndIncrement` call below.
const DEFAULT_MAX_APPLIES_PER_DAY = 5;

const db = openDb('data.sqlite');

interface AtsModule {
  detect(url: string): string | null;
  fieldMap: FieldMap;
}

const ATS_MODULES: AtsModule[] = [greenhouse, lever, workday, ashby];

/** Required fields — if a selector for any of these is missing on the page, the
 * application is routed to manual_review rather than being submitted. */
const REQUIRED_FIELDS: Array<keyof FieldMap> = ['name', 'email', 'resumeUpload'];

/**
 * Splits a full name on the first whitespace boundary into first/last parts.
 * A single-word name (no whitespace) yields an empty last name.
 */
export function splitName(fullName: string | undefined): { first: string; last: string } {
  const trimmed = (fullName ?? '').trim();
  if (!trimmed) return { first: '', last: '' };
  const idx = trimmed.indexOf(' ');
  if (idx === -1) return { first: trimmed, last: '' };
  return { first: trimmed.slice(0, idx), last: trimmed.slice(idx + 1).trim() };
}

/**
 * Returns the [key, selector] pairs that must resolve on the page before submission.
 * When a platform's fieldMap declares both `firstName` and `lastName` selectors, those
 * replace the combined `name` requirement so the gate checks the selectors that will
 * actually be filled, rather than the (unused) combined-name selector.
 */
function getRequiredFieldEntries(fieldMap: FieldMap): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const key of REQUIRED_FIELDS) {
    if (key === 'name' && fieldMap.firstName && fieldMap.lastName) {
      entries.push(['firstName', fieldMap.firstName], ['lastName', fieldMap.lastName]);
      continue;
    }
    entries.push([key, fieldMap[key] as string]);
  }
  return entries;
}

export interface AtsDetection {
  platform: string;
  fieldMap: FieldMap;
}

/** Pure: given an apply_url, figure out which ATS platform hosts it (or null). */
export function detectAts(url: string): AtsDetection | null {
  for (const mod of ATS_MODULES) {
    const platform = mod.detect(url);
    if (platform) return { platform, fieldMap: mod.fieldMap };
  }
  return null;
}

export interface ApplyExternalResult {
  job_id: string;
  status: 'submitted' | 'manual_review' | 'failed' | 'rate_limited';
  platform?: string | null;
  reason?: string;
}

export interface ApplyExternalDeps {
  db?: BetterSqlite3.Database;
  maxAppliesPerDay?: number;
  /** Injectable Playwright `chromium` launcher, for testing without a real browser. */
  chromium?: { launch: typeof chromium.launch };
}

function recordAndReturn(
  database: BetterSqlite3.Database,
  jobId: string,
  platform: string | null,
  status: 'submitted' | 'manual_review' | 'failed',
  reason?: string
): ApplyExternalResult {
  saveApplication(database, {
    job_id: jobId,
    platform,
    status,
    reason: reason ?? null,
    applied_at: status === 'submitted' ? new Date().toISOString() : null,
  });
  return { job_id: jobId, status, platform, reason };
}

export async function applyExternal(
  { job_id }: { job_id: string },
  deps: ApplyExternalDeps = {}
): Promise<ApplyExternalResult> {
  const database = deps.db ?? db;
  const browserLauncher = deps.chromium ?? chromium;

  const job = getJob(database, job_id);
  if (!job || !job.apply_url) {
    return recordAndReturn(database, job_id, null, 'manual_review', 'job not found or missing apply_url');
  }

  const prepared = database
    .prepare('SELECT resume_path, body FROM outreach WHERE job_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(job_id) as { resume_path: string; body: string } | undefined;

  if (!prepared || !prepared.resume_path) {
    return recordAndReturn(
      database,
      job_id,
      null,
      'manual_review',
      'no tailored resume/cover letter prepared for this job (run outreach-preparer first)'
    );
  }

  const ats = detectAts(job.apply_url);
  if (!ats) {
    return recordAndReturn(database, job_id, null, 'manual_review', 'unsupported ATS platform');
  }

  const applicant = getBaseResume();

  // Gate immediately before the Playwright launch — after every cheap, pure, non-browser
  // pre-flight check above (job lookup, tailored-resume lookup, ATS detection, base resume
  // fetch) has already had a chance to reject the request for free, so a rejection never
  // burns a quota slot for a no-op.
  //
  // Judgment call: this shares the SAME 'easy_apply' counter key as linkedin-apply.ts's
  // `apply_easy_apply`, per the design spec (docs/superpowers/specs/2026-07-07-jobapplier-
  // phase2-design.md §5.1: "Rate-limited by MAX_APPLIES_PER_DAY (shared counter with 5.2)"),
  // where §5.2 is this file. So `MAX_APPLIES_PER_DAY` is one combined daily cap across
  // LinkedIn Easy Apply + external ATS applies, not two independent caps.
  const maxPerDay =
    deps.maxAppliesPerDay ?? Number(process.env.MAX_APPLIES_PER_DAY ?? DEFAULT_MAX_APPLIES_PER_DAY);
  const allowed = checkAndIncrement(database, 'easy_apply', maxPerDay);
  if (!allowed) {
    return {
      job_id,
      status: 'rate_limited',
      platform: ats.platform,
      reason: `daily apply limit (${maxPerDay}) reached`,
    };
  }

  let browser;
  try {
    browser = await browserLauncher.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(job.apply_url, { timeout: 30000, waitUntil: 'domcontentloaded' });

    for (const [key, selector] of getRequiredFieldEntries(ats.fieldMap)) {
      const el = await page.$(selector);
      if (!el) {
        return recordAndReturn(
          database,
          job_id,
          ats.platform,
          'manual_review',
          `required field "${key}" not found on page (selector: ${selector})`
        );
      }
    }

    if (ats.fieldMap.firstName && ats.fieldMap.lastName) {
      const { first, last } = splitName(applicant.name);
      await page.fill(ats.fieldMap.firstName, first);
      await page.fill(ats.fieldMap.lastName, last);
    } else {
      await page.fill(ats.fieldMap.name, applicant.name ?? '');
    }

    await page.fill(ats.fieldMap.email, applicant.email ?? '');

    if (applicant.phone) {
      const phoneEl = await page.$(ats.fieldMap.phone);
      if (phoneEl) await page.fill(ats.fieldMap.phone, applicant.phone);
    }

    const coverLetterEl = await page.$(ats.fieldMap.coverLetter);
    if (coverLetterEl && prepared.body) {
      await page.fill(ats.fieldMap.coverLetter, prepared.body);
    }

    await page.setInputFiles(ats.fieldMap.resumeUpload, prepared.resume_path);

    const submitEl = await page.$(ats.fieldMap.submitButton);
    if (!submitEl) {
      return recordAndReturn(
        database,
        job_id,
        ats.platform,
        'manual_review',
        `submit button not found on page (selector: ${ats.fieldMap.submitButton})`
      );
    }
    await submitEl.click();

    return recordAndReturn(database, job_id, ats.platform, 'submitted');
  } catch (err) {
    return recordAndReturn(
      database,
      job_id,
      ats.platform,
      'failed',
      (err as Error).message ?? 'unknown error during external apply'
    );
  } finally {
    if (browser) await browser.close();
  }
}

const server = new McpServer({ name: 'external-apply', version: '0.1.0' });

server.registerTool(
  'apply_external',
  {
    description:
      'Apply directly to a Greenhouse/Lever/Workday/Ashby-hosted job posting using its apply_url, ' +
      'filling in the tailored resume and cover letter prepared for that job. Gated by the same daily ' +
      'MAX_APPLIES_PER_DAY limit shared with apply_easy_apply. Falls back to manual_review if the ATS ' +
      'is unsupported or a required field cannot be located.',
    inputSchema: {
      job_id: z.string(),
    },
  },
  async ({ job_id }) => {
    const result = await applyExternal({ job_id });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.env.VITEST !== 'true') {
  main().catch((err) => {
    console.error('[external-apply] fatal error:', err);
    process.exit(1);
  });
}
