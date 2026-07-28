import { describe, it, expect } from 'vitest';
import { buildNaukriSearchUrl, extractNaukriJobId, parseNaukriCards } from '../src/sources/naukri.js';

describe('buildNaukriSearchUrl', () => {
  it('builds a URL with role and location slugified', () => {
    expect(buildNaukriSearchUrl('Full Stack Developer', 'India')).toBe(
      'https://www.naukri.com/full-stack-developer-jobs-in-india'
    );
  });

  it('omits the location segment when location is not given', () => {
    expect(buildNaukriSearchUrl('Full Stack Developer')).toBe(
      'https://www.naukri.com/full-stack-developer-jobs'
    );
  });

  it('slugifies special characters and multiple spaces', () => {
    expect(buildNaukriSearchUrl('React / Node.js Dev', 'Bengaluru (Bangalore)')).toBe(
      'https://www.naukri.com/react-node-js-dev-jobs-in-bengaluru-bangalore'
    );
  });
});

describe('extractNaukriJobId', () => {
  it('extracts the trailing numeric id from a real Naukri listing URL', () => {
    expect(
      extractNaukriJobId(
        'https://www.naukri.com/job-listings-full-stack-developer-i-fedex-express-hyderabad-2-to-5-years-150426501261'
      )
    ).toBe('150426501261');
  });

  it('strips a query string before extracting the id', () => {
    expect(extractNaukriJobId('https://www.naukri.com/job-listings-foo-12345?src=abc')).toBe('12345');
  });

  it('returns null when the URL has no trailing numeric segment', () => {
    expect(extractNaukriJobId('https://www.naukri.com/job-listings-foo-bar')).toBeNull();
  });
});

describe('parseNaukriCards', () => {
  it('parses a valid card into a Job with a naukri:<id> id', () => {
    const result = parseNaukriCards([
      {
        titleText: 'Full Stack Developer',
        companyText: 'Acme',
        hrefRaw: 'https://www.naukri.com/job-listings-full-stack-developer-acme-12345',
        descriptionText: 'Build things',
      },
    ]);

    expect(result.parsed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.jobs).toEqual([
      {
        id: 'naukri:12345',
        source: 'naukri',
        title: 'Full Stack Developer',
        company: 'Acme',
        url: 'https://www.naukri.com/job-listings-full-stack-developer-acme-12345',
        apply_url: 'https://www.naukri.com/job-listings-full-stack-developer-acme-12345',
        description: 'Build things',
      },
    ]);
  });

  it('skips a card missing a title, without throwing', () => {
    const result = parseNaukriCards([
      {
        titleText: null,
        companyText: 'Acme',
        hrefRaw: 'https://www.naukri.com/job-listings-foo-1',
        descriptionText: null,
      },
    ]);
    expect(result.parsed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.jobs).toEqual([]);
  });

  it('skips a card missing an href, without throwing', () => {
    const result = parseNaukriCards([
      { titleText: 'Foo', companyText: 'Acme', hrefRaw: null, descriptionText: null },
    ]);
    expect(result.skipped).toBe(1);
  });

  it('skips a card whose href has no extractable job id', () => {
    const result = parseNaukriCards([
      {
        titleText: 'Foo',
        companyText: 'Acme',
        hrefRaw: 'https://www.naukri.com/job-listings-foo-bar',
        descriptionText: null,
      },
    ]);
    expect(result.skipped).toBe(1);
  });

  it('handles a missing company/description gracefully', () => {
    const result = parseNaukriCards([
      {
        titleText: 'Foo',
        companyText: null,
        hrefRaw: 'https://www.naukri.com/job-listings-foo-99',
        descriptionText: null,
      },
    ]);
    expect(result.jobs[0].company).toBe('');
    expect(result.jobs[0].description).toBe('');
  });
});
