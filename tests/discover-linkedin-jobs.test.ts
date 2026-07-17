import { describe, it, expect } from 'vitest';
import {
  loadDiscoverConfig,
  extractLinkedInJobId,
  parseLinkedInJobCards,
  type RawJobCard,
} from '../src/discover/linkedin-jobs.js';

describe('loadDiscoverConfig', () => {
  it('reads jobs and posts config from config/discover-linkedin.json', () => {
    const config = loadDiscoverConfig();
    expect(typeof config.jobs.search_url).toBe('string');
    expect(typeof config.jobs.limit).toBe('number');
    expect(typeof config.posts.role).toBe('string');
    expect(typeof config.posts.geo).toBe('string');
    expect(typeof config.posts.limit).toBe('number');
  });
});

describe('extractLinkedInJobId', () => {
  it('extracts the numeric job id from a standard job view URL', () => {
    expect(extractLinkedInJobId('https://www.linkedin.com/jobs/view/3891234567/')).toBe('3891234567');
  });

  it('extracts the id when the URL has query params after it', () => {
    expect(
      extractLinkedInJobId('https://www.linkedin.com/jobs/view/3891234567/?refId=abc&trackingId=xyz')
    ).toBe('3891234567');
  });

  it('returns null for a URL with no job id', () => {
    expect(extractLinkedInJobId('https://www.linkedin.com/jobs/search/?keywords=react')).toBeNull();
  });
});

describe('parseLinkedInJobCards', () => {
  it('parses well-formed cards into Job objects', () => {
    const rawCards: RawJobCard[] = [
      {
        titleText: '  Senior React Developer  ',
        companyText: '  Acme Corp  ',
        hrefRaw: 'https://www.linkedin.com/jobs/view/1111111111/',
        snippetText: '  Remote, India  ',
        easyApply: true,
      },
      {
        titleText: 'Full Stack Engineer',
        companyText: 'Widgets Inc',
        hrefRaw: 'https://www.linkedin.com/jobs/view/2222222222/?refId=x',
        snippetText: 'Bengaluru, India',
        easyApply: false,
      },
    ];

    const result = parseLinkedInJobCards(rawCards);

    expect(result.found).toBe(2);
    expect(result.parsed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.jobs).toEqual([
      {
        id: 'li-job:1111111111',
        source: 'linkedin-jobs',
        title: 'Senior React Developer',
        company: 'Acme Corp',
        url: 'https://www.linkedin.com/jobs/view/1111111111/',
        apply_url: 'https://www.linkedin.com/jobs/view/1111111111/',
        description: 'Remote, India',
      },
      {
        id: 'li-job:2222222222',
        source: 'linkedin-jobs',
        title: 'Full Stack Engineer',
        company: 'Widgets Inc',
        url: 'https://www.linkedin.com/jobs/view/2222222222/?refId=x',
        apply_url: 'https://www.linkedin.com/jobs/view/2222222222/?refId=x',
        description: 'Bengaluru, India',
      },
    ]);
  });

  it('skips a card with no title without failing the rest of the page', () => {
    const rawCards: RawJobCard[] = [
      { titleText: null, companyText: 'Acme', hrefRaw: 'https://www.linkedin.com/jobs/view/111/', snippetText: null, easyApply: false },
      { titleText: 'Good Job', companyText: 'Acme', hrefRaw: 'https://www.linkedin.com/jobs/view/222/', snippetText: null, easyApply: false },
    ];

    const result = parseLinkedInJobCards(rawCards);

    expect(result.found).toBe(2);
    expect(result.parsed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].id).toBe('li-job:222');
  });

  it('skips a card whose href has no extractable job id', () => {
    const rawCards: RawJobCard[] = [
      { titleText: 'Mystery Job', companyText: 'Acme', hrefRaw: 'https://www.linkedin.com/jobs/search/?keywords=x', snippetText: null, easyApply: false },
    ];

    const result = parseLinkedInJobCards(rawCards);

    expect(result.parsed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.jobs).toHaveLength(0);
  });
});
