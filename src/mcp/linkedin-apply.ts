import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { chromium } from 'playwright';
import BetterSqlite3 from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, getJob, saveApplication } from '../db.js';
import { checkAndIncrement } from '../lib/rateLimit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

// Burner-only session state. This MCP must NEVER load `secrets/linkedin-main-state.json`
// (that account is reserved for the `connect` MCP in Task 4). The path is intentionally
// hardcoded, not a configurable parameter.
const BURNER_STATE_PATH = path.join(projectRoot, 'secrets', 'linkedin-burner-state.json');
const ANSWERS_CONFIG_PATH = path.join(projectRoot, 'config', 'easy-apply-answers.json');

const DEFAULT_MAX_APPLIES_PER_DAY = 5;

const db = openDb('data.sqlite');

export interface EasyApplyAnswers {
  years_experience: number;
  authorized_to_work: boolean;
  requires_sponsorship: boolean;
  willing_to_relocate: boolean;
  notice_period_days: number;
  expected_salary: string;
  phone: string;
  linkedin_profile_url: string;
}

export type AnswerValue = string | number | boolean;

/** Keyword/regex patterns matched (in order) against a screening question's text. */
const QUESTION_PATTERNS: Array<{ pattern: RegExp; key: keyof EasyApplyAnswers }> = [
  { pattern: /years?\b.{0,20}\bexperience/i, key: 'years_experience' },
  { pattern: /authoriz(e|ed|ation)\b.{0,25}\bwork/i, key: 'authorized_to_work' },
  { pattern: /sponsorship/i, key: 'requires_sponsorship' },
  { pattern: /relocat/i, key: 'willing_to_relocate' },
  { pattern: /notice period/i, key: 'notice_period_days' },
  { pattern: /salary/i, key: 'expected_salary' },
  { pattern: /phone/i, key: 'phone' },
  { pattern: /linkedin.{0,15}(profile|url)/i, key: 'linkedin_profile_url' },
];

/**
 * Pure: matches a screening question's text against known patterns and returns the
 * corresponding value from the answers config, or null if the question is unrecognized.
 * Callers MUST treat a null return as "unanswerable" and abort to manual_review rather
 * than guessing or submitting with a blank/default value.
 */
export function resolveAnswer(question: string, answers: EasyApplyAnswers): AnswerValue | null {
  for (const { pattern, key } of QUESTION_PATTERNS) {
    if (pattern.test(question)) {
      return answers[key];
    }
  }
  return null;
}

function loadAnswers(): EasyApplyAnswers {
  return JSON.parse(readFileSync(ANSWERS_CONFIG_PATH, 'utf8'));
}

export interface ApplyEasyApplyResult {
  job_id: string;
  status: 'submitted' | 'manual_review' | 'failed' | 'rate_limited';
  reason?: string;
}

function recordAndReturn(
  database: BetterSqlite3.Database,
  jobId: string,
  status: 'submitted' | 'manual_review' | 'failed',
  reason?: string
): ApplyEasyApplyResult {
  saveApplication(database, {
    job_id: jobId,
    platform: 'linkedin',
    method: 'easy_apply',
    account: 'burner',
    status,
    reason: reason ?? null,
    applied_at: status === 'submitted' ? new Date().toISOString() : null,
  });
  return { job_id: jobId, status, reason };
}

// Best-effort LinkedIn Easy Apply DOM selectors. LinkedIn's markup changes and isn't
// publicly stable the way Greenhouse/Lever/Workday/Ashby's is, so these are a starting
// point and were not confirmed against a live modal (see Task 3 Step 5, deliberately
// deferred to a human-supervised live test).
const SELECTORS = {
  easyApplyButton: 'button.jobs-apply-button, button[aria-label*="Easy Apply" i]',
  formGrouping: '.jobs-easy-apply-form-section__grouping, .fb-dash-form-element',
  questionLabel: 'label',
  textInput: 'input[type="text"], input[type="number"], input[type="tel"], textarea',
  nextButton: 'button[aria-label="Continue to next step"]',
  reviewButton: 'button[aria-label="Review your application"]',
  submitButton: 'button[aria-label="Submit application"]',
  resumeUpload: 'input[type="file"]',
} as const;

const MAX_FORM_STEPS = 10;

export interface ApplyEasyApplyDeps {
  db?: BetterSqlite3.Database;
  maxAppliesPerDay?: number;
  /** Injectable Playwright `chromium` launcher, for testing without a real browser. */
  chromium?: { launch: typeof chromium.launch };
}

export async function applyEasyApply(
  { job_id }: { job_id: string },
  deps: ApplyEasyApplyDeps = {}
): Promise<ApplyEasyApplyResult> {
  const database = deps.db ?? db;
  const browserLauncher = deps.chromium ?? chromium;
  const maxPerDay =
    deps.maxAppliesPerDay ?? Number(process.env.MAX_APPLIES_PER_DAY ?? DEFAULT_MAX_APPLIES_PER_DAY);

  const allowed = checkAndIncrement(database, 'easy_apply', maxPerDay);
  if (!allowed) {
    return {
      job_id,
      status: 'rate_limited',
      reason: `daily Easy Apply limit (${maxPerDay}) reached`,
    };
  }

  const job = getJob(database, job_id);
  if (!job || !job.url) {
    return recordAndReturn(database, job_id, 'manual_review', 'job not found or missing url');
  }

  let answers: EasyApplyAnswers;
  try {
    answers = loadAnswers();
  } catch (err) {
    return recordAndReturn(
      database,
      job_id,
      'manual_review',
      `failed to load answers config: ${(err as Error).message}`
    );
  }

  if (!existsSync(BURNER_STATE_PATH)) {
    return recordAndReturn(database, job_id, 'manual_review', 'burner session state not found');
  }

  let browser;
  try {
    browser = await browserLauncher.launch({ headless: true });
    const context = await browser.newContext({ storageState: BURNER_STATE_PATH });
    const page = await context.newPage();
    await page.goto(job.url, { timeout: 30000, waitUntil: 'domcontentloaded' });

    const easyApplyButton = await page.$(SELECTORS.easyApplyButton);
    if (!easyApplyButton) {
      return recordAndReturn(
        database,
        job_id,
        'manual_review',
        'Easy Apply button not found (posting may not support Easy Apply)'
      );
    }
    await easyApplyButton.click();

    for (let step = 0; step < MAX_FORM_STEPS; step++) {
      const groupings = await page.$$(SELECTORS.formGrouping);
      for (const grouping of groupings) {
        const labelEl = await grouping.$(SELECTORS.questionLabel);
        const questionText = labelEl ? ((await labelEl.textContent()) ?? '').trim() : '';
        if (!questionText) continue;

        const answer = resolveAnswer(questionText, answers);
        if (answer === null) {
          // Real, verifiable early-return before any submit action: an unrecognized
          // screening question means we cannot answer truthfully, so abort here rather
          // than guessing or clicking further.
          return recordAndReturn(
            database,
            job_id,
            'manual_review',
            `unanswerable screening question: "${questionText}"`
          );
        }

        const inputEl = await grouping.$(SELECTORS.textInput);
        if (inputEl) {
          await inputEl.fill(String(answer));
        }
      }

      const submitButton = await page.$(SELECTORS.submitButton);
      if (submitButton) break;

      const nextButton = (await page.$(SELECTORS.nextButton)) ?? (await page.$(SELECTORS.reviewButton));
      if (!nextButton) {
        return recordAndReturn(
          database,
          job_id,
          'manual_review',
          'could not find a next/review/submit control on the Easy Apply form'
        );
      }
      await nextButton.click();
    }

    const resumeUploadEl = await page.$(SELECTORS.resumeUpload);
    const prepared = database
      .prepare('SELECT resume_path FROM outreach WHERE job_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(job_id) as { resume_path: string } | undefined;
    if (resumeUploadEl && prepared?.resume_path) {
      await page.setInputFiles(SELECTORS.resumeUpload, prepared.resume_path);
    }

    const submitButton = await page.$(SELECTORS.submitButton);
    if (!submitButton) {
      return recordAndReturn(database, job_id, 'manual_review', 'submit button not found on final step');
    }
    await submitButton.click();

    return recordAndReturn(database, job_id, 'submitted');
  } catch (err) {
    return recordAndReturn(database, job_id, 'failed', (err as Error).message ?? 'unknown error during easy apply');
  } finally {
    if (browser) await browser.close();
  }
}

const server = new McpServer({ name: 'linkedin-apply', version: '0.1.0' });

server.registerTool(
  'apply_easy_apply',
  {
    description:
      'Applies to a LinkedIn job posting via Easy Apply using the burner account session. ' +
      'Gated by a daily MAX_APPLIES_PER_DAY limit. Falls back to manual_review if the burner ' +
      'session is missing, the posting has no Easy Apply button, or a screening question cannot ' +
      'be answered from config/easy-apply-answers.json.',
    inputSchema: {
      job_id: z.string(),
    },
  },
  async ({ job_id }) => {
    const result = await applyEasyApply({ job_id });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.env.VITEST !== 'true') {
  main().catch((err) => {
    console.error('[linkedin-apply] fatal error:', err);
    process.exit(1);
  });
}
