import { describe, it, expect } from 'vitest';
import { applyVetoes } from '../src/vetoes.js';

const job = { title: 'Full Stack Dev', description: 'React and Node. Onsite in Berlin. Unpaid trial week.' };

describe('applyVetoes', () => {
  it('excludes on location FAIL even with a high score', () => {
    const r = applyVetoes({ job_id: 'a', score: 95, location_verdict: 'FAIL' }, job, []);
    expect(r).toEqual({ excluded: true, reason: 'location FAIL', flags: [] });
  });
  it('excludes on language FAIL', () => {
    expect(applyVetoes({ job_id: 'a', score: 90, language_gate: 'FAIL' }, job, []).excluded).toBe(true);
  });
  it('keeps FLAGs with a marker', () => {
    expect(applyVetoes({ job_id: 'a', score: 70, language_gate: 'FLAG' }, job, [])).toEqual({ excluded: false, flags: ['language FLAG'] });
  });
  it('excludes on a deal-breaker keyword, case-insensitive', () => {
    const r = applyVetoes({ job_id: 'a', score: 80 }, job, ['unpaid']);
    expect(r.excluded).toBe(true);
    expect(r.reason).toBe('deal-breaker: unpaid');
  });
  it('passes when no verdict fields are present (old matcher output)', () => {
    expect(applyVetoes({ job_id: 'a', score: 80 }, job, [])).toEqual({ excluded: false, flags: [] });
  });
});
