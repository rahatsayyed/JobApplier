import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveAnswer, applyEasyApply, SELECTORS, type EasyApplyAnswers } from '../src/mcp/linkedin-apply.js';
import { openDb, saveJob } from '../src/db.js';
import type Database from 'better-sqlite3';

const answers: EasyApplyAnswers = {
  years_experience: 5,
  authorized_to_work: true,
  requires_sponsorship: false,
  willing_to_relocate: true,
  notice_period_days: 30,
  expected_salary: '25 LPA',
  phone: '+91-9999999999',
  linkedin_profile_url: 'https://linkedin.com/in/example',
};

describe('resolveAnswer', () => {
  it('matches "years of experience" style questions', () => {
    expect(resolveAnswer('How many years of experience do you have with React?', answers)).toBe(5);
    expect(resolveAnswer('Years of experience', answers)).toBe(5);
  });

  it('matches "authorized to work" style questions', () => {
    expect(resolveAnswer('Are you legally authorized to work in this country?', answers)).toBe(true);
  });

  it('matches sponsorship questions', () => {
    expect(
      resolveAnswer('Will you now or in the future require sponsorship for employment visa status?', answers)
    ).toBe(false);
  });

  it('matches relocation questions', () => {
    expect(resolveAnswer('Are you willing to relocate for this role?', answers)).toBe(true);
  });

  it('matches notice period questions', () => {
    expect(resolveAnswer('What is your current notice period (in days)?', answers)).toBe(30);
  });

  it('matches expected salary questions', () => {
    expect(resolveAnswer('What are your salary expectations?', answers)).toBe('25 LPA');
  });

  it('matches phone questions', () => {
    expect(resolveAnswer('Mobile phone number', answers)).toBe('+91-9999999999');
  });

  it('matches LinkedIn profile URL questions', () => {
    expect(resolveAnswer('Please share your LinkedIn profile URL', answers)).toBe(
      'https://linkedin.com/in/example'
    );
  });

  it('returns null for unrecognized questions', () => {
    expect(resolveAnswer('What is your favorite color?', answers)).toBeNull();
    expect(resolveAnswer('Describe a time you overcame a challenge at work.', answers)).toBeNull();
  });
});

/**
 * A minimal fake Playwright element: `click`/`fill` are spies so tests can assert
 * whether a submit/click action was ever attempted.
 */
function makeFakeElement(overrides: Partial<{ textContent: () => Promise<string | null> }> = {}) {
  return {
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    textContent: overrides.textContent ?? vi.fn().mockResolvedValue(null),
  };
}

/**
 * A minimal fake Playwright `Locator`: wraps zero-or-one fake element(s) and exposes
 * the subset of the Locator API the implementation uses (`count`, `first`, `nth`,
 * `click`, `fill`, `textContent`, `locator`). `first()`/`nth()` return the same
 * locator object since these fakes only ever represent a single logical match.
 */
function makeFakeLocator(el: ReturnType<typeof makeFakeElement> | null): any {
  const locator: any = {
    count: vi.fn().mockResolvedValue(el ? 1 : 0),
    click: vi.fn(async () => {
      if (!el) throw new Error('no element matched by locator');
      return el.click();
    }),
    fill: vi.fn(async (value: string) => {
      if (!el) throw new Error('no element matched by locator');
      return el.fill(value);
    }),
    textContent: vi.fn(async () => (el ? el.textContent() : null)),
    locator: vi.fn(() => makeFakeLocator(null)),
    waitFor: vi.fn().mockResolvedValue(undefined),
  };
  locator.first = vi.fn(() => locator);
  locator.nth = vi.fn(() => locator);
  return locator;
}

/**
 * A fake "form grouping" locator: represents one `.nth(i)` result of the groupings
 * locator, and itself exposes `.locator(selector)` for the nested question-label /
 * text-input lookups within that grouping.
 */
function makeFakeGroupingLocator({
  label = null,
  input = null,
}: {
  label?: ReturnType<typeof makeFakeElement> | null;
  input?: ReturnType<typeof makeFakeElement> | null;
} = {}) {
  return {
    locator: vi.fn((selector: string) => {
      if (selector === 'label') return makeFakeLocator(label);
      return makeFakeLocator(input);
    }),
  };
}

/**
 * A fake locator representing multiple matches (e.g. `page.locator(formGrouping)`),
 * backed by an array of grouping-locator-like objects (see above).
 */
function makeFakeGroupingsLocator(groupings: ReturnType<typeof makeFakeGroupingLocator>[]) {
  return {
    count: vi.fn().mockResolvedValue(groupings.length),
    first: vi.fn(() => ({ ...groupings[0], waitFor: vi.fn().mockResolvedValue(undefined) })),
    nth: vi.fn((i: number) => groupings[i]),
  };
}

describe('SELECTORS next/review/submit buttons', () => {
  // These are pure string assertions on the selector VALUES, not proof the selector
  // actually resolves on a real LinkedIn page (that can only be verified live — see
  // .superpowers/sdd/task-6-selector-fix-report.md). What we CAN assert statically:
  // no dependence on aria-label/hashed classes anymore, and every selector is scoped
  // to the `footer` ancestor so it can't accidentally match an unrelated page button.
  it('scopes next/review/submit selectors to a footer ancestor with text-based matching', () => {
    expect(SELECTORS.nextButton).toMatch(/^footer /);
    expect(SELECTORS.reviewButton).toMatch(/^footer /);
    expect(SELECTORS.submitButton).toMatch(/^footer /);

    expect(SELECTORS.nextButton).toContain(':has-text("Next")');
    expect(SELECTORS.reviewButton).toContain(':has-text("Review")');
    expect(SELECTORS.submitButton).toContain(':has-text("Submit")');
  });

  it('no longer relies on aria-label attributes for next/review/submit', () => {
    expect(SELECTORS.nextButton).not.toContain('aria-label');
    expect(SELECTORS.reviewButton).not.toContain('aria-label');
    expect(SELECTORS.submitButton).not.toContain('aria-label');
  });
});

describe('applyEasyApply control flow', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('returns rate_limited and never touches Playwright when the daily limit is already reached', async () => {
    const launch = vi.fn();
    const fakeChromium = { launch };

    saveJob(db, {
      id: 'job-rl-1',
      source: 'linkedin',
      title: 'Full Stack Developer',
      company: 'Acme Corp',
      url: 'https://linkedin.com/jobs/view/1',
      apply_url: 'https://linkedin.com/jobs/view/1',
      description: 'React role',
    });

    const result = await applyEasyApply(
      { job_id: 'job-rl-1' },
      { db, maxAppliesPerDay: 0, chromium: fakeChromium }
    );

    expect(result.status).toBe('rate_limited');
    // The rate-limit gate must be checked BEFORE any Playwright action — launch()
    // should never be invoked once the limit is already exhausted.
    expect(launch).not.toHaveBeenCalled();
  });

  it('returns manual_review and never clicks submit when a screening question is unanswerable', async () => {
    saveJob(db, {
      id: 'job-mr-1',
      source: 'linkedin',
      title: 'Full Stack Developer',
      company: 'Acme Corp',
      url: 'https://linkedin.com/jobs/view/2',
      apply_url: 'https://linkedin.com/jobs/view/2',
      description: 'React role',
    });

    const easyApplyButton = makeFakeElement();
    const submitButton = makeFakeElement();
    const nextButton = makeFakeElement();

    const unrecognizedLabel = makeFakeElement({
      textContent: vi.fn().mockResolvedValue('What is your favorite color?'),
    });
    const grouping = makeFakeGroupingLocator({ label: unrecognizedLabel });

    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockImplementation((selector: string) => {
        if (selector.includes('Easy Apply')) return makeFakeLocator(easyApplyButton);
        if (selector.includes('Submit')) return makeFakeLocator(submitButton);
        if (selector.includes('Next')) return makeFakeLocator(nextButton);
        if (selector.includes('jobs-easy-apply-form-section__grouping')) return makeFakeGroupingsLocator([grouping]);
        return makeFakeLocator(null);
      }),
      setInputFiles: vi.fn().mockResolvedValue(undefined),
    };

    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const launch = vi.fn().mockResolvedValue(browser);
    const fakeChromium = { launch };

    const result = await applyEasyApply(
      { job_id: 'job-mr-1' },
      { db, chromium: fakeChromium }
    );

    expect(result.status).toBe('manual_review');
    expect(result.reason).toMatch(/unanswerable screening question/);
    // The easy-apply button click is expected (it happens before the screening
    // questions are read), but the submit button must never be clicked once an
    // unanswerable question forces an early return to manual_review.
    expect(easyApplyButton.click).toHaveBeenCalledTimes(1);
    expect(submitButton.click).not.toHaveBeenCalled();
    expect(nextButton.click).not.toHaveBeenCalled();
  });

  it('falls through to the normal manual_review path when waitForFormControls times out after the Easy Apply click', async () => {
    // Regression test for the `.catch(() => {})` in `waitForFormControls` (src/mcp/linkedin-apply.ts).
    // That helper wraps a bounded `locator.waitFor(...)` in a swallowing catch so a timeout
    // falls through to the existing `.count()`-based manual_review fallbacks instead of
    // throwing. Every other test's fake `waitFor` resolves instantly, so none of them
    // actually exercise the rejection branch. This test forces `waitFor` to reject at the
    // FIRST call site (immediately after the Easy Apply button click) and asserts the run
    // still completes with `manual_review` (not `failed`, and not an uncaught throw).
    saveJob(db, {
      id: 'job-mr-timeout-1',
      source: 'linkedin',
      title: 'Full Stack Developer',
      company: 'Acme Corp',
      url: 'https://linkedin.com/jobs/view/3',
      apply_url: 'https://linkedin.com/jobs/view/3',
      description: 'React role',
    });

    const easyApplyButton = makeFakeElement();

    // No form groupings render at all (empty groupings locator) — combined with no
    // next/review/submit control found, this exercises the pre-existing
    // "could not find a next/review/submit control" manual_review fallback, proving
    // the timed-out waitFor() did not derail the rest of the flow.
    const emptyGroupingsLocator = {
      count: vi.fn().mockResolvedValue(0),
      first: vi.fn(() => ({ waitFor: vi.fn().mockResolvedValue(undefined) })),
      nth: vi.fn(() => makeFakeGroupingLocator()),
    };

    // waitForFormControls builds one joined selector string containing all four
    // candidate selectors (formGrouping, nextButton, reviewButton, submitButton) and
    // calls `.first().waitFor(...)` on it. That joined string is the only selector
    // containing a comma, so we can distinguish it from the individual selectors below
    // (which the rest of the implementation queries separately via `.count()`).
    const rejectingWaitForLocator = {
      count: vi.fn().mockResolvedValue(0),
      first: vi.fn(() => ({
        waitFor: vi.fn().mockRejectedValue(new Error('Timeout 8000ms exceeded waiting for locator')),
      })),
    };

    // The joined "any control" selector built inside `waitForFormControls` is the only
    // selector queried anywhere in the implementation that contains ALL of these four
    // substrings at once (formGrouping + nextButton + reviewButton + submitButton joined
    // by ', ') — every other individual selector query (Easy Apply button, bare Next
    // button, bare Review button, bare Submit button, bare form grouping) is missing at
    // least one of them. This lets the fake distinguish the joined wait-helper call from
    // the implementation's own separate `.count()` lookups.
    const isAnyControlsSelector = (selector: string) =>
      selector.includes('jobs-easy-apply-form-section__grouping') &&
      selector.includes('Next') &&
      selector.includes('Review') &&
      selector.includes('Submit');

    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockImplementation((selector: string) => {
        if (isAnyControlsSelector(selector)) return rejectingWaitForLocator;
        if (selector.includes('Easy Apply')) return makeFakeLocator(easyApplyButton);
        // Bare Next/Review/Submit control lookups (used by the loop's own fallback
        // checks) are all absent, so after the timed-out wait, the loop correctly
        // falls through to "could not find a next/review/submit control".
        if (selector.includes('Submit')) return makeFakeLocator(null);
        if (selector.includes('Review')) return makeFakeLocator(null);
        if (selector.includes('Next')) return makeFakeLocator(null);
        if (selector.includes('jobs-easy-apply-form-section__grouping')) return emptyGroupingsLocator;
        return makeFakeLocator(null);
      }),
      setInputFiles: vi.fn().mockResolvedValue(undefined),
    };

    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const launch = vi.fn().mockResolvedValue(browser);
    const fakeChromium = { launch };

    const result = await applyEasyApply(
      { job_id: 'job-mr-timeout-1' },
      { db, chromium: fakeChromium }
    );

    expect(result.status).toBe('manual_review');
    expect(result.reason).toMatch(/could not find a next\/review\/submit control/);
    // The Easy Apply click itself must still have happened before the timed-out wait.
    expect(easyApplyButton.click).toHaveBeenCalledTimes(1);
  });
});
