import type { Job } from '../db.js';
import { fetchAdzuna } from './adzuna.js';
import { fetchRemotive } from './remotive.js';
import { fetchRemoteok } from './remoteok.js';
import { fetchNaukriJobs } from './naukri.js';

export async function fetchAllJobs(params: { role: string; location?: string }): Promise<Job[]> {
  const [adzuna, remotive, remoteok, naukri] = await Promise.all([
    fetchAdzuna({ role: params.role, location: params.location }),
    fetchRemotive({ role: params.role }),
    fetchRemoteok(),
    fetchNaukriJobs({ role: params.role, location: params.location }),
  ]);
  return [...adzuna, ...remotive, ...remoteok, ...naukri];
}
