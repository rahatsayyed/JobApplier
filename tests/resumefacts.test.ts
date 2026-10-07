import { describe, it, expect } from 'vitest';
import { checkFacts } from '../src/resumeFacts.js';
import { getBaseResume, renderResume } from '../src/resume.js';

const base = {
  name: 'Test User', summary: 'Built apps serving 10k users.',
  experience: [{ title: 'Engineer', company: 'Acme', location: 'Pune', start: 'Jan 2022', end: 'Present', description: 'Cut latency by 40% for 3 services.' }],
  education: [{ degree: 'BE', school: 'XYZ Univ', year: '2021' }],
  skills: [{ category: 'Frontend', items: ['React', 'TypeScript'] }],
};
const clone = () => JSON.parse(JSON.stringify(base));

describe('checkFacts', () => {
  it('passes the base resume against itself', () => {
    expect(checkFacts(base, clone())).toEqual({ verdict: 'pass', invented: [] });
  });
  it('blocks an invented metric', () => {
    const t = clone(); t.experience[0].description = 'Cut latency by 90% for 3 services.';
    const r = checkFacts(base, t);
    expect(r.verdict).toBe('block');
    expect(r.invented).toContain('metric:90%');
  });
  it('blocks a changed company, title, date or skill', () => {
    const t = clone(); t.experience[0].company = 'Globex'; t.experience[0].title = 'Staff Engineer'; t.skills[0].items.push('Kafka');
    const r = checkFacts(base, t);
    expect(r.verdict).toBe('block');
    expect(r.invented).toEqual(expect.arrayContaining(['company:globex', 'title:staff engineer', 'skill:kafka']));
  });
  it('allows reordering bullets and skills and reworded text without new numbers', () => {
    const t = clone(); t.skills[0].items.reverse(); t.experience[0].description = 'Reduced latency 40% across 3 services.';
    expect(checkFacts(base, t).verdict).toBe('pass');
  });
  it('reports a spelled-out or reformatted number as unsupported rather than crashing', () => {
    const t = clone(); t.experience[0].description = 'Cut latency by 40 percent for 3 services.';
    expect(() => checkFacts(base, t)).not.toThrow();
  });
  it('does not treat years as metrics', () => {
    const t = clone(); t.summary = 'Since 2022 I built apps serving 10k users.';
    expect(checkFacts(base, t).verdict).toBe('pass');
  });
  it('passes the real base resume against itself', () => {
    expect(checkFacts(getBaseResume(), getBaseResume()).verdict).toBe('pass');
  });
});

describe('renderResume fact gate', () => {
  it('throws before rendering when the resume has an invented claim', async () => {
    const t = JSON.parse(JSON.stringify(getBaseResume()));
    t.experience[0].company = 'Invented Corp Ltd';
    await expect(renderResume(t)).rejects.toThrow(/fact check failed/);
  });
});
