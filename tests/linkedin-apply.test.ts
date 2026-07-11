import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveAnswer, applyEasyApply, type EasyApplyAnswers } from '../src/mcp/linkedin-apply.js';
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
    first: vi.fn(() => groupings[0]),
    nth: vi.fn((i: number) => groupings[i]),
  };
}

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
        if (selector.includes('Submit application')) return makeFakeLocator(submitButton);
        if (selector.includes('Continue to next step')) return makeFakeLocator(nextButton);
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
});
