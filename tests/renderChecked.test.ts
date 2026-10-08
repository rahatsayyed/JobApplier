import { describe, it, expect } from 'vitest';
import { getBaseResume, renderResumeChecked } from '../src/resume.js';

describe('renderResumeChecked (real renders)', () => {
  it('renders the base resume on one page with a fill ratio and no trims', async () => {
    const r = await renderResumeChecked(getBaseResume());
    expect(r.trimmed).toEqual([]);
    expect(r.facts.verdict).not.toBe('block');
    expect(r.fillRatio).toBeGreaterThan(0.5);
    expect(r.ats).toBeNull();
  }, 120_000);

  it('trims duplicated low-relevance bullets until the page fits, and classifies keywords', async () => {
    const t = JSON.parse(JSON.stringify(getBaseResume()));
    // 3 duplicated bullets overflow the page by about 3 bullets, within the default 6 trims.
    t.experience[0].description = [...t.experience[0].description, ...t.experience[0].description.slice(0, 3)];
    const r = await renderResumeChecked(t, { keywords: [{ term: 'React', priority: 'required' }, { term: 'Kubernetes', priority: 'required' }] });
    expect(r.trimmed.length).toBeGreaterThan(0);
    expect(r.resume.experience[0].description.length).toBeLessThan(t.experience[0].description.length);
    expect(r.ats).toEqual([
      { term: 'React', priority: 'required', status: 'covered' },
      { term: 'Kubernetes', priority: 'required', status: 'gap' },
    ]);
    expect(r.atsCoverage).toBe(50);
  }, 300_000);

  it('refuses to render an unsupported claim', async () => {
    const t = JSON.parse(JSON.stringify(getBaseResume()));
    t.summary += ' Comfortable owning products end to end.';
    await expect(renderResumeChecked(t)).rejects.toThrow(/Resume fact check failed.*scope:ownership/);
  }, 60_000);
});
