import { describe, it, expect } from 'vitest';
import {
  extractActivityUrn,
  isHiringIntent,
  parseLinkedInPostCards,
  buildLinkedInPostSearchUrl,
  type RawPostCard,
} from '../src/discover/linkedin-posts.js';

describe('extractActivityUrn', () => {
  it('extracts the activity id from a permalink href', () => {
    expect(
      extractActivityUrn('https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/')
    ).toBe('7123456789012345678');
  });

  it('returns null when there is no activity urn', () => {
    expect(extractActivityUrn('https://www.linkedin.com/in/someone/')).toBeNull();
  });
});

describe('isHiringIntent', () => {
  it('matches common hiring phrasing', () => {
    expect(isHiringIntent("We're hiring a Senior React Developer!")).toBe(true);
    expect(isHiringIntent('Join our team as a Backend Engineer')).toBe(true);
    expect(isHiringIntent('Looking for a Full Stack Developer')).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(isHiringIntent('Excited to share my new certification!')).toBe(false);
  });
});

describe('buildLinkedInPostSearchUrl', () => {
  it('builds a content-search URL with role keywords, sorted by latest', () => {
    const url = buildLinkedInPostSearchUrl('full stack developer', 'in');
    expect(url).toContain('linkedin.com/search/results/content/');
    expect(url).toContain('full+stack+developer');
    expect(decodeURIComponent(url)).toContain('date_posted');
  });
});

describe('parseLinkedInPostCards', () => {
  it('parses a hiring-intent card into a Job', () => {
    const rawCards: RawPostCard[] = [
      {
        textContent: "We're hiring a Senior React Developer, remote, India.",
        hrefRaw: 'https://www.linkedin.com/feed/update/urn:li:activity:1111111111111111111/',
        authorText: 'Jane Recruiter',
      },
    ];

    const result = parseLinkedInPostCards(rawCards);

    expect(result.found).toBe(1);
    expect(result.parsed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.jobs).toEqual([
      {
        id: 'li-post:1111111111111111111',
        source: 'linkedin-posts',
        title: 'Jane Recruiter',
        company: '',
        url: 'https://www.linkedin.com/feed/update/urn:li:activity:1111111111111111111/',
        apply_url: 'https://www.linkedin.com/feed/update/urn:li:activity:1111111111111111111/',
        description: "We're hiring a Senior React Developer, remote, India.",
      },
    ]);
  });

  it('silently excludes a non-hiring post without counting it as skipped', () => {
    const rawCards: RawPostCard[] = [
      {
        textContent: 'Just got a new certification, excited!',
        hrefRaw: 'https://www.linkedin.com/feed/update/urn:li:activity:2222222222222222222/',
        authorText: 'Someone',
      },
    ];

    const result = parseLinkedInPostCards(rawCards);

    expect(result.found).toBe(1);
    expect(result.parsed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.jobs).toHaveLength(0);
  });

  it('skips a malformed card (no href) without failing the rest of the page', () => {
    const rawCards: RawPostCard[] = [
      { textContent: "We're hiring!", hrefRaw: null, authorText: 'Someone' },
      {
        textContent: "We're hiring a Backend Engineer",
        hrefRaw: 'https://www.linkedin.com/feed/update/urn:li:activity:3333333333333333333/',
        authorText: 'Other Recruiter',
      },
    ];

    const result = parseLinkedInPostCards(rawCards);

    expect(result.found).toBe(2);
    expect(result.parsed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].id).toBe('li-post:3333333333333333333');
  });
});
