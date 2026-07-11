import { describe, it, expect } from 'vitest';
import { detect as detectGreenhouse, fieldMap as greenhouseFieldMap } from '../src/ats/greenhouse.js';
import { detect as detectLever, fieldMap as leverFieldMap } from '../src/ats/lever.js';
import { detect as detectWorkday, fieldMap as workdayFieldMap } from '../src/ats/workday.js';
import { detect as detectAshby, fieldMap as ashbyFieldMap } from '../src/ats/ashby.js';
import { detectAts } from '../src/mcp/external-apply.js';

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
