import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detect as detectGreenhouse, fieldMap as greenhouseFieldMap } from '../src/ats/greenhouse.js';
import { detect as detectLever, fieldMap as leverFieldMap } from '../src/ats/lever.js';
import { detect as detectWorkday, fieldMap as workdayFieldMap } from '../src/ats/workday.js';
import { detect as detectAshby, fieldMap as ashbyFieldMap } from '../src/ats/ashby.js';
import { detectAts, splitName, applyExternal } from '../src/mcp/external-apply.js';
import { openDb, saveJob, saveOutreach } from '../src/db.js';
import type Database from 'better-sqlite3';

const REQUIRED_FIELD_KEYS = ['name', 'email', 'phone', 'resumeUpload', 'coverLetter'];

function expectFieldMapComplete(fieldMap: Record<string, unknown>) {
  for (const key of REQUIRED_FIELD_KEYS) {
    expect(fieldMap).toHaveProperty(key);
    expect(typeof fieldMap[key]).toBe('string');
    expect((fieldMap[key] as string).length).toBeGreaterThan(0);
  }
}

describe('greenhouse ATS', () => {
  it('detects greenhouse-hosted job board URLs', () => {
    expect(detectGreenhouse('https://boards.greenhouse.io/acme/jobs/123')).toBe('greenhouse');
    expect(detectGreenhouse('https://job-boards.greenhouse.io/acme/jobs/123')).toBe('greenhouse');
  });

  it('returns null for non-greenhouse URLs', () => {
    expect(detectGreenhouse('https://jobs.lever.co/acme/123')).toBeNull();
    expect(detectGreenhouse('not a url')).toBeNull();
  });

  it('fieldMap has all required selector keys', () => {
    expectFieldMapComplete(greenhouseFieldMap as unknown as Record<string, unknown>);
  });

  it('splits the name field into separate first/last selectors (Greenhouse form has both inputs)', () => {
    expect(greenhouseFieldMap.firstName).toBe('#first_name');
    expect(greenhouseFieldMap.lastName).toBe('#last_name');
    // firstName/lastName should be distinct from a combined-name selector.
    expect(greenhouseFieldMap.firstName).not.toBe(greenhouseFieldMap.lastName);
  });
});

describe('lever ATS', () => {
  it('detects lever-hosted job URLs', () => {
    expect(detectLever('https://jobs.lever.co/acme/abc-123')).toBe('lever');
  });

  it('returns null for non-lever URLs', () => {
    expect(detectLever('https://boards.greenhouse.io/acme/jobs/123')).toBeNull();
  });

  it('fieldMap has all required selector keys', () => {
    expectFieldMapComplete(leverFieldMap as unknown as Record<string, unknown>);
  });

  it('uses a single combined name field (Lever form has no separate first/last inputs)', () => {
    expect(leverFieldMap.firstName).toBeUndefined();
    expect(leverFieldMap.lastName).toBeUndefined();
  });
});

describe('workday ATS', () => {
  it('detects myworkdayjobs.com URLs', () => {
    expect(detectWorkday('https://acme.wd1.myworkdayjobs.com/en-US/acme_careers/job/Remote/Engineer_R123')).toBe(
      'workday'
    );
  });

  it('returns null for non-workday URLs', () => {
    expect(detectWorkday('https://jobs.ashbyhq.com/acme/abc')).toBeNull();
  });

  it('fieldMap has all required selector keys', () => {
    expectFieldMapComplete(workdayFieldMap as unknown as Record<string, unknown>);
  });

  it('splits the name field into separate first/last selectors (Workday form has both inputs)', () => {
    expect(workdayFieldMap.firstName).toBe('[data-automation-id="legalNameSection_firstName"]');
    expect(workdayFieldMap.lastName).toBe('[data-automation-id="legalNameSection_lastName"]');
    expect(workdayFieldMap.firstName).not.toBe(workdayFieldMap.lastName);
  });
});

describe('ashby ATS', () => {
  it('detects ashbyhq.com URLs', () => {
    expect(detectAshby('https://jobs.ashbyhq.com/acme/abc-123')).toBe('ashby');
  });

  it('returns null for non-ashby URLs', () => {
    expect(detectAshby('https://acme.wd1.myworkdayjobs.com/job/1')).toBeNull();
  });

  it('fieldMap has all required selector keys', () => {
    expectFieldMapComplete(ashbyFieldMap as unknown as Record<string, unknown>);
  });

  it('uses a single combined name field (Ashby form has no separate first/last inputs)', () => {
    expect(ashbyFieldMap.firstName).toBeUndefined();
    expect(ashbyFieldMap.lastName).toBeUndefined();
  });
});

describe('detectAts', () => {
  it('routes a URL to the correct platform + fieldMap', () => {
    const result = detectAts('https://boards.greenhouse.io/acme/jobs/123');
    expect(result?.platform).toBe('greenhouse');
    expectFieldMapComplete(result!.fieldMap as unknown as Record<string, unknown>);
  });

  it('returns null when no platform matches', () => {
    expect(detectAts('https://example.com/careers/123')).toBeNull();
  });
});

describe('splitName', () => {
  it('splits a "First Last" string on the first whitespace boundary', () => {
    expect(splitName('Rahat Sayyed')).toEqual({ first: 'Rahat', last: 'Sayyed' });
  });

  it('splits a "First Middle Last" string keeping everything after the first space as last', () => {
    expect(splitName('Mary Jane Watson')).toEqual({ first: 'Mary', last: 'Jane Watson' });
  });

  it('treats a single-word name as first name only, with an empty last name', () => {
    expect(splitName('Cher')).toEqual({ first: 'Cher', last: '' });
  });

  it('handles undefined/empty input without throwing', () => {
    expect(splitName(undefined)).toEqual({ first: '', last: '' });
    expect(splitName('')).toEqual({ first: '', last: '' });
    expect(splitName('   ')).toEqual({ first: '', last: '' });
  });
});

describe('applyExternal rate limiting (Finding 1)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  function seedApplicableJob(jobId: string) {
    saveJob(db, {
      id: jobId,
      source: 'greenhouse',
      title: 'Full Stack Developer',
      company: 'Acme Corp',
      url: 'https://boards.greenhouse.io/acme/jobs/123',
      apply_url: 'https://boards.greenhouse.io/acme/jobs/123',
      description: 'React role',
    });
    saveOutreach(db, {
      job_id: jobId,
      contact_email: 'hiring@acme.com',
      subject: 'Application',
      body: 'Cover letter body',
      resume_path: '/tmp/fake-resume.pdf',
    });
  }

  it('returns rate_limited and never touches Playwright when the daily apply limit is already reached', async () => {
    seedApplicableJob('job-ext-rl-1');
    const launch = vi.fn();

    const result = await applyExternal(
      { job_id: 'job-ext-rl-1' },
      { db, maxAppliesPerDay: 0, chromium: { launch } }
    );

    expect(result.status).toBe('rate_limited');
    expect(result.platform).toBe('greenhouse');
    // The rate-limit gate must be checked BEFORE any Playwright action — launch()
    // should never be invoked once the limit is already exhausted.
    expect(launch).not.toHaveBeenCalled();
  });

  it('shares the same "easy_apply" daily counter as linkedin-apply.ts (documented shared cap)', async () => {
    seedApplicableJob('job-ext-shared-1');

    // Pre-exhaust the shared counter the way applyEasyApply would.
    db.prepare('INSERT INTO daily_counters (day, key, count) VALUES (date(\'now\'), ?, ?)').run(
      'easy_apply',
      1
    );

    const launch = vi.fn();
    const result = await applyExternal(
      { job_id: 'job-ext-shared-1' },
      { db, maxAppliesPerDay: 1, chromium: { launch } }
    );

    expect(result.status).toBe('rate_limited');
    expect(launch).not.toHaveBeenCalled();
  });

  it('does not burn a quota slot on a cheap pre-flight rejection (Finding 2: job not found)', async () => {
    const launch = vi.fn();

    const result = await applyExternal(
      { job_id: 'job-does-not-exist' },
      { db, maxAppliesPerDay: 5, chromium: { launch } }
    );

    expect(result.status).toBe('manual_review');
    expect(launch).not.toHaveBeenCalled();

    const row = db
      .prepare("SELECT count FROM daily_counters WHERE day = date('now') AND key = ?")
      .get('easy_apply') as { count: number } | undefined;
    expect(row).toBeUndefined();
  });

  it('does not burn a quota slot on a cheap pre-flight rejection (Finding 2: no tailored resume prepared)', async () => {
    saveJob(db, {
      id: 'job-ext-no-outreach',
      source: 'greenhouse',
      title: 'Full Stack Developer',
      company: 'Acme Corp',
      url: 'https://boards.greenhouse.io/acme/jobs/456',
      apply_url: 'https://boards.greenhouse.io/acme/jobs/456',
      description: 'React role',
    });
    const launch = vi.fn();

    const result = await applyExternal(
      { job_id: 'job-ext-no-outreach' },
      { db, maxAppliesPerDay: 5, chromium: { launch } }
    );

    expect(result.status).toBe('manual_review');
    expect(launch).not.toHaveBeenCalled();

    const row = db
      .prepare("SELECT count FROM daily_counters WHERE day = date('now') AND key = ?")
      .get('easy_apply') as { count: number } | undefined;
    expect(row).toBeUndefined();
  });

  it('does not burn a quota slot on a cheap pre-flight rejection (Finding 2: unsupported ATS)', async () => {
    saveJob(db, {
      id: 'job-ext-unsupported-ats',
      source: 'other',
      title: 'Full Stack Developer',
      company: 'Acme Corp',
      url: 'https://example.com/careers/123',
      apply_url: 'https://example.com/careers/123',
      description: 'React role',
    });
    saveOutreach(db, {
      job_id: 'job-ext-unsupported-ats',
      contact_email: 'hiring@acme.com',
      subject: 'Application',
      body: 'Cover letter body',
      resume_path: '/tmp/fake-resume.pdf',
    });
    const launch = vi.fn();

    const result = await applyExternal(
      { job_id: 'job-ext-unsupported-ats' },
      { db, maxAppliesPerDay: 5, chromium: { launch } }
    );

    expect(result.status).toBe('manual_review');
    expect(result.reason).toMatch(/unsupported ATS platform/);
    expect(launch).not.toHaveBeenCalled();

    const row = db
      .prepare("SELECT count FROM daily_counters WHERE day = date('now') AND key = ?")
      .get('easy_apply') as { count: number } | undefined;
    expect(row).toBeUndefined();
  });
});
