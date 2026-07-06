import type { Job } from '../db.js';

export function normalizeSerper(raw: any): Job[] {
  const organic = raw?.organic ?? [];
  return organic
    .filter((o: any) => typeof o.link === 'string' && o.link.includes('linkedin.com/posts'))
    .map((o: any): Job => ({
      id: `dork:${o.link}`,
      source: 'dork',
      title: o.title,
      company: '',
      url: o.link,
      apply_url: o.link,
      description: o.snippet,
    }));
}

function buildQueries(role: string, geo: string): string[] {
  return [
    `site:linkedin.com/posts ("we're hiring" OR "we are hiring" OR "I'm hiring") (${role}) ${geo}`,
    `site:linkedin.com/posts ("hiring" OR "join our team") (${role}) ${geo}`,
    `site:linkedin.com/posts ("looking for" OR "open position") (${role}) ${geo}`,
  ];
}

async function serperSearch(q: string, geo: string): Promise<any> {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': process.env.SERPER_API_KEY ?? '',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ q, num: 20, gl: geo }),
  });
  if (!res.ok) {
    throw new Error(`Serper request failed: ${res.status}`);
  }
  return res.json();
}

export async function fetchSerper(params: { role: string; geo?: string }): Promise<Job[]> {
  const geo = params.geo || 'in';
  try {
    const queries = buildQueries(params.role, geo);
    const results = await Promise.all(
      queries.map(async (q) => {
        try {
          const raw = await serperSearch(q, geo);
          return normalizeSerper(raw);
        } catch (err) {
          console.error('[serper] query failed:', err);
          return [];
        }
      })
    );
    return results.flat();
  } catch (err) {
    console.error('[serper] fetch failed:', err);
    return [];
  }
}
