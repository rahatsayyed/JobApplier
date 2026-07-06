import type { Job } from '../db.js';
import { fetchAdzuna } from './adzuna.js';
import { fetchRemotive } from './remotive.js';
import { fetchRemoteok } from './remoteok.js';
import { fetchSerper } from './serper.js';

export async function fetchAllJobs(params: { role: string; location?: string }): Promise<Job[]> {
  const [adzuna, remotive, remoteok] = await Promise.all([
    fetchAdzuna({ role: params.role, location: params.location }),
    fetchRemotive({ role: params.role }),
    fetchRemoteok(),
  ]);
  return [...adzuna, ...remotive, ...remoteok];
}

export async function fetchHiringPosts(params: { role: string; geo?: string }): Promise<Job[]> {
  return fetchSerper({ role: params.role, geo: params.geo });
}
