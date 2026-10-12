import type { Job } from '../db.js';
import { fetchAdzuna } from './adzuna.js';
import { fetchRemotive } from './remotive.js';
import { fetchRemoteok } from './remoteok.js';
import { fetchNaukri } from './naukri.js';
import { fetchBoards } from './boards/index.js';

export async function fetchAllJobs(params: { role: string; location?: string }): Promise<Job[]> {
  const [adzuna, remotive, remoteok, naukri, boards] = await Promise.all([
    fetchAdzuna({ role: params.role, location: params.location }),
    fetchRemotive({ role: params.role }),
    fetchRemoteok(),
    fetchNaukri({ role: params.role, location: params.location }),
    // Boards ignore role/location on purpose: only the filters in config/portals.json apply to them.
    // A board failure (or a missing/invalid portals.json) never loses the other sources.
    fetchBoards().then((r) => r.jobs).catch((e) => { console.error('[boards] failed:', e); return [] as Job[]; }),
  ]);
  return [...adzuna, ...remotive, ...remoteok, ...naukri, ...boards];
}
