// Adapted from career-ops-hq/career-ops providers/lever.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama). See that repo's LICENSE.
import { toIsoDay } from '../../db.js';
import { assertSlug, safeVendorUrl, type TrackedCompany } from './filters.js';
import { capDescription, getJson, type BoardJob } from './greenhouse.js';

export function normalizeLever(raw: any, c: TrackedCompany): BoardJob[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: BoardJob[] = [];
  for (const p of list) {
    if (!p || typeof p.id !== 'string' || !/^[A-Za-z0-9-]+$/.test(p.id) || typeof p.text !== 'string') continue;
    const all = Array.isArray(p.categories?.allLocations) && p.categories.allLocations.length
      ? p.categories.allLocations.filter((x: unknown): x is string => typeof x === 'string')
      : [typeof p.categories?.location === 'string' ? p.categories.location : ''];
    const posted = toIsoDay(p.createdAt);
    const description = capDescription([p.descriptionPlain, p.additionalPlain].filter((x) => typeof x === 'string' && x.trim()).join('\n\n'));
    const canonical = `https://jobs${c.region === 'eu' ? '.eu' : ''}.lever.co/${c.slug}/${p.id}`;
    const url = safeVendorUrl(p.hostedUrl, 'lever.co', canonical);
    out.push({
      id: `lever:${c.slug}:${p.id}`,
      source: 'lever',
      title: p.text,
      company: c.name,
      url,
      apply_url: safeVendorUrl(p.applyUrl, 'lever.co', `${url.replace(/\/$/, '')}/apply`),
      description,
      ...(posted ? { posted_at: posted } : {}),
      locations: all.length ? all : [''],
      remote: p.workplaceType === 'remote' || all.some((l: string) => /remote/i.test(l)),
    });
  }
  return out;
}

export async function fetchLever(c: TrackedCompany): Promise<BoardJob[]> {
  assertSlug(c.slug);
  const host = c.region === 'eu' ? 'api.eu.lever.co' : 'api.lever.co';
  const raw = await getJson(`https://${host}/v0/postings/${encodeURIComponent(c.slug)}?mode=json`, `lever ${c.slug}`);
  return normalizeLever(raw, c);
}
