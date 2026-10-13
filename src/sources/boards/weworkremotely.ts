// Adapted from career-ops-hq/career-ops providers/weworkremotely.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama). See that repo's LICENSE.
// Board-wide RSS feed: GET https://weworkremotely.com/remote-jobs.rss
//   <rss><channel><item><title>Company: Role</title><link/><pubDate/><region/><category/>[<description/>]</item>...
// career-ops reads title, link, pubDate, region and category. The <description> element (HTML body) is NOT confirmed from career-ops code:
// an item without one is skipped and counted in a warning (it would be saved description-less). An item whose title has no "Company: " prefix is
// skipped too (no company means no contact search). url and apply_url are the weworkremotely.com page; discover-only (src/lib/discoverOnly.ts).
// Every posting here is remote; the region decides the location filter ("Anywhere in the World" is worldwide, "USA Only" is not).
import { toIsoDay } from '../../db.js';
import { hostMatches } from '../../lib/hostClass.js';
import { htmlToPlain, type TrackedCompany } from './filters.js';
import { capDescription, clip, MAX_JOBS_PER_BOARD, MAX_URL_CHARS, type BoardJob, type FetchCtx } from './greenhouse.js';
import { exactHosts, getText } from './transport.js';
import { shortHash } from './util.js';
import { childOf, childrenOf, parseXml, textOf } from './xml.js';

const HOSTS = exactHosts('weworkremotely.com');
const FEED = 'https://weworkremotely.com/remote-jobs.rss';

const wwrUrl = (u: string): string => (u.length <= MAX_URL_CHARS && /^https:\/\//i.test(u) && hostMatches(u, 'weworkremotely.com') ? u : '');

export function normalizeWwr(xml: string, c: TrackedCompany): { jobs: BoardJob[]; noDescription: number } {
  const channel = childOf(childOf(parseXml(xml), 'rss'), 'channel');
  if (!channel) throw new Error(`weworkremotely ${c.slug}: unexpected response shape (no rss channel)`);
  const jobs: BoardJob[] = [];
  let noDescription = 0;
  for (const it of childrenOf(channel, 'item').slice(0, MAX_JOBS_PER_BOARD)) {
    const url = wwrUrl(textOf(it, 'link'));
    const raw = textOf(it, 'title');
    const colon = raw.indexOf(':');
    const company = colon > 0 ? raw.slice(0, colon).trim() : '';
    const title = colon > 0 ? raw.slice(colon + 1).trim() : '';
    if (!url || !company || !title) continue;
    const description = capDescription(htmlToPlain(textOf(it, 'description')));
    if (!description) { noDescription++; continue; }
    const region = textOf(it, 'region');
    const ms = Date.parse(textOf(it, 'pubDate'));
    const posted = Number.isNaN(ms) ? undefined : toIsoDay(ms);
    jobs.push({
      id: `wwr:${shortHash(url, 16)}`,
      source: 'weworkremotely',
      title: clip(title),
      company: clip(company),
      url,
      apply_url: url,
      description,
      ...(posted ? { posted_at: posted } : {}),
      locations: [/anywhere in the world|worldwide/i.test(region) ? 'Worldwide' : clip(region || 'Unknown region')],
      remote: true,
    });
  }
  return { jobs, noDescription };
}

export async function fetchWeWorkRemotely(c: TrackedCompany, ctx: FetchCtx = {}): Promise<BoardJob[]> {
  const label = `weworkremotely ${c.slug}`;
  const xml = await getText(FEED, label, { hosts: HOSTS });
  let r: { jobs: BoardJob[]; noDescription: number };
  try {
    r = normalizeWwr(xml, c);
  } catch (e: any) {
    const m = String(e?.message ?? e);
    throw new Error(m.startsWith('weworkremotely ') ? m : `${label}: ${m}`);
  }
  if (r.noDescription) ctx.warn?.(`${r.noDescription} posting(s) skipped: no description in the feed`);
  return r.jobs;
}
