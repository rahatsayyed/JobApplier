import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { chromium, type Page } from 'playwright';
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
// publicly stable the way Greenhouse/Lever/Workday/Ashby's is.
//
// nextButton/reviewButton/submitButton were live-tested against a real Easy Apply
// modal (see .superpowers/sdd/task-6-selector-fix-report.md) and confirmed to render
// with fully obfuscated/hashed CSS classes, NO aria-label, NO role="dialog", and NO
// data-test-* attributes anywhere in the ancestor chain. The one stable anchor found
// was a semantic `<footer>` tag a few levels up (the modal's action-button row), with
// the button's visible text content ("Next" confirmed live; "Review"/"Submit" are
// reasonable-copy guesses per LinkedIn's known step labels, not live-verified). These
// selectors use Playwright's `:has-text()` (case-insensitive substring match) scoped
// to `footer` so they tolerate minor copy variations (e.g. "Submit application" vs
// "Submit") without accidentally matching unrelated buttons elsewhere on the page.
export const SELECTORS = {
  easyApplyButton: 'button.jobs-apply-button, button[aria-label*="Easy Apply" i]',
  formGrouping: '.jobs-easy-apply-form-section__grouping, .fb-dash-form-element',
  questionLabel: 'label',
  textInput: 'input[type="text"], input[type="number"], input[type="tel"], textarea',
  nextButton: 'footer button:has-text("Next")',
  reviewButton: 'footer button:has-text("Review")',
  submitButton: 'footer button:has-text("Submit")',
  resumeUpload: 'input[type="file"]',
} as const;

const MAX_FORM_STEPS = 10;

// How long to wait for the Easy Apply modal (or its next form step) to actually render
// before checking for controls. Bounded and non-throwing: `Locator.click()` only
// auto-waits for the clicked element itself to be actionable, not for whatever the click
// triggers afterward (e.g. a modal animating in), and `Locator.count()` is a synchronous
// snapshot with no retry — so without this wait, the very next `.count()` checks race the
// modal's render and can see 0 elements that appear a moment later. Confirmed live: the
// real modal's "Next" button (inside a `<footer>`) rendered ~2.5s after the Easy Apply
// click (see .superpowers/sdd/task-6-timing-fix-report.md). We wait for ANY of the
// controls a healthy render could produce next (a form grouping, or a next/review/submit
// button) rather than a fixed sleep, so the wait ends as soon as the DOM is actually
// ready instead of always burning the full timeout. If nothing appears in time, we
// swallow the timeout and fall through to the existing `.count()` checks, which then
// correctly resolve to the existing manual_review fallbacks.
const MODAL_RENDER_TIMEOUT_MS = 8000;

async function waitForFormControls(page: Pick<Page, 'locator'>): Promise<void> {
  const anySelector = [
    SELECTORS.formGrouping,
    SELECTORS.nextButton,
    SELECTORS.reviewButton,
    SELECTORS.submitButton,
  ].join(', ');
  await page
    .locator(anySelector)
    .first()
    .waitFor({ state: 'visible', timeout: MODAL_RENDER_TIMEOUT_MS })
    .catch(() => {
      // Timed out waiting for the modal/next-step to render. Don't throw — let the
      // caller's existing `.count()` checks run and take the normal manual_review path.
    });
}

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

  // Cheap, pure, non-browser pre-flight checks run BEFORE the rate-limit gate below, so a
  // pre-flight rejection (missing job, bad answers config, missing burner session) never
  // burns a quota slot for a no-op that was never going to touch Playwright.
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

  // Gate immediately before the Playwright launch — still strictly "before any Playwright
  // action", just moved as late as possible so the cheap checks above get first refusal.
  const allowed = checkAndIncrement(database, 'easy_apply', maxPerDay);
  if (!allowed) {
    return {
      job_id,
      status: 'rate_limited',
      reason: `daily Easy Apply limit (${maxPerDay}) reached`,
    };
  }

  let browser;
  try {
    browser = await browserLauncher.launch({ headless: true });
    const context = await browser.newContext({ storageState: BURNER_STATE_PATH });
    const page = await context.newPage();
    await page.goto(job.url, { timeout: 30000, waitUntil: 'domcontentloaded' });

    // Locators (not ElementHandles) are used throughout: a Locator re-resolves its
    // selector at the moment of each action, so it survives the re-renders/animations
    // of LinkedIn's Easy Apply modal. An ElementHandle instead pins to one DOM node
    // captured at query time, which can detach before a later `.click()`/`.fill()`
    // fires — causing "Element is not attached to the DOM" failures.
    const easyApplyButtonLocator = page.locator(SELECTORS.easyApplyButton);
    if ((await easyApplyButtonLocator.count()) === 0) {
      return recordAndReturn(
        database,
        job_id,
        'manual_review',
        'Easy Apply button not found (posting may not support Easy Apply)'
      );
    }
    await easyApplyButtonLocator.first().click();
    await waitForFormControls(page);

    for (let step = 0; step < MAX_FORM_STEPS; step++) {
      const groupingLocator = page.locator(SELECTORS.formGrouping);
      const groupingCount = await groupingLocator.count();
      for (let i = 0; i < groupingCount; i++) {
        const grouping = groupingLocator.nth(i);
        const labelLocator = grouping.locator(SELECTORS.questionLabel);
        const questionText =
          (await labelLocator.count()) > 0 ? ((await labelLocator.first().textContent()) ?? '').trim() : '';
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

        const inputLocator = grouping.locator(SELECTORS.textInput);
        if ((await inputLocator.count()) > 0) {
          await inputLocator.first().fill(String(answer));
        }
      }

      const submitButtonLocator = page.locator(SELECTORS.submitButton);
      if ((await submitButtonLocator.count()) > 0) break;

      const nextButtonLocator = page.locator(SELECTORS.nextButton);
      const nextButtonCount = await nextButtonLocator.count();
      const reviewButtonLocator = page.locator(SELECTORS.reviewButton);
      const reviewButtonCount = nextButtonCount > 0 ? 0 : await reviewButtonLocator.count();
      if (nextButtonCount === 0 && reviewButtonCount === 0) {
        return recordAndReturn(
          database,
          job_id,
          'manual_review',
          'could not find a next/review/submit control on the Easy Apply form'
        );
      }
      if (nextButtonCount > 0) {
        await nextButtonLocator.first().click();
      } else {
        await reviewButtonLocator.first().click();
      }
      await waitForFormControls(page);
    }

    const resumeUploadCount = await page.locator(SELECTORS.resumeUpload).count();
    const prepared = database
      .prepare('SELECT resume_path FROM outreach WHERE job_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(job_id) as { resume_path: string } | undefined;
    if (resumeUploadCount > 0 && prepared?.resume_path) {
      await page.setInputFiles(SELECTORS.resumeUpload, prepared.resume_path);
    }

    const finalSubmitButtonLocator = page.locator(SELECTORS.submitButton);
    if ((await finalSubmitButtonLocator.count()) === 0) {
      return recordAndReturn(database, job_id, 'manual_review', 'submit button not found on final step');
    }
    await finalSubmitButtonLocator.first().click();

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
