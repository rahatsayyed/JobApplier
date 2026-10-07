import { describe, it, expect, vi, afterEach } from 'vitest';
import { classifyLiveness, checkLiveness } from '../src/liveness.js';
import { vetoResults } from '../src/vetoes.js';

const base = { status: 200, requestedUrl: 'https://x.com/jobs/123456', finalUrl: 'https://x.com/jobs/123456' };
const body = (t: string) => ({ ...base, bodyText: t.padEnd(400, ' filler') });

describe('classifyLiveness', () => {
  it('404 and 410 are expired', () => {
    expect(classifyLiveness({ ...base, status: 404, bodyText: '' })).toBe('expired');
    expect(classifyLiveness({ ...base, status: 410, bodyText: '' })).toBe('expired');
  });
  it('403, 429, 503 and anti-bot pages are uncertain, never expired', () => {
    expect(classifyLiveness({ ...base, status: 403, bodyText: '' })).toBe('uncertain');
    expect(classifyLiveness(body('Just a moment... verify you are human'))).toBe('uncertain');
  });
  it('hard-expired phrases are expired', () => {
    expect(classifyLiveness(body('This job is no longer available'))).toBe('expired');
    expect(classifyLiveness(body('The position has been filled'))).toBe('expired');
  });
  it('ignores a conditional phrase on a live page', () => {
    expect(classifyLiveness(body('We will close this listing until the position has been filled. Apply now'))).not.toBe('expired');
  });
  it('a redirect that drops the job id is uncertain', () => {
    expect(classifyLiveness({ ...body('Browse all open roles'), finalUrl: 'https://x.com/careers' })).toBe('uncertain');
  });
  it('a live page with an apply control is active', () => {
    expect(classifyLiveness(body('Senior Dev. Apply now'))).toBe('active');
  });
  it('a tiny body is expired only when no other signal says otherwise', () => {
    expect(classifyLiveness({ ...base, bodyText: 'ok' })).toBe('expired');
  });
});

describe('checkLiveness', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('404 response is expired', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 404, url: 'https://x.com/jobs/123456', text: async () => '' }));
    expect(await checkLiveness('https://x.com/jobs/123456')).toBe('expired');
  });
  it('a thrown error is uncertain', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    expect(await checkLiveness('https://x.com/jobs/123456')).toBe('uncertain');
  });
});

describe('vetoResults', () => {
  const jobs = [{ id: 'a', title: 'Dev', description: 'Unpaid trial' }];
  it('drops blank/whitespace keywords and trims', () => {
    const r = vetoResults([{ job_id: 'a', score: 80 }], jobs, ['  ', '', ' nothing-here ']);
    expect(r[0].excluded).toBe(false);
    const r2 = vetoResults([{ job_id: 'a', score: 80 }], jobs, [' unpaid ']);
    expect(r2[0]).toEqual({ job_id: 'a', excluded: true, reason: 'deal-breaker: unpaid', flags: [] });
  });
  it('handles a missing job', () => {
    const r = vetoResults([{ job_id: 'zzz', score: 80, language_gate: 'FLAG' }], jobs, ['unpaid']);
    expect(r).toEqual([{ job_id: 'zzz', excluded: false, flags: ['language FLAG'] }]);
  });
  it('excludes on FAIL verdict', () => {
    const r = vetoResults([{ job_id: 'a', score: 99, location_verdict: 'FAIL' }], jobs, []);
    expect(r[0]).toMatchObject({ job_id: 'a', excluded: true, reason: 'location FAIL' });
  });
});
