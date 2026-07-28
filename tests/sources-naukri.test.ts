import { describe, it, expect } from 'vitest';
import { buildNaukriSearchUrl, extractNaukriJobId } from '../src/sources/naukri.js';

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
