// Check a company board before adding it to config/portals.json:
//   npx tsx scripts/check-portal.ts <greenhouse|lever|ashby> <slug> [--eu]
// Prints how many jobs the board has and how many pass the configured title + location filters.
// Exit codes: 0 ok, 1 fetch failure, 2 usage or invalid slug. (A live check is a user step: it uses the network.)
import { fetchGreenhouse } from '../src/sources/boards/greenhouse.js';
import { fetchLever } from '../src/sources/boards/lever.js';
import { fetchAshby } from '../src/sources/boards/ashby.js';
import { isValidSlug, loadPortals, locationAllowed, titlePasses, type Ats } from '../src/sources/boards/filters.js';

const [ats, slug] = process.argv.slice(2).filter((a) => !a.startsWith('--')) as [Ats, string];
if (!['greenhouse', 'lever', 'ashby'].includes(ats) || !slug) {
  console.error('usage: npx tsx scripts/check-portal.ts <greenhouse|lever|ashby> <slug> [--eu]');
  process.exit(2);
}
if (!isValidSlug(slug)) {
  console.error(`invalid slug ${JSON.stringify(slug)} (letters, digits, ".", "_" and "-" only; must start with a letter or digit)`);
  process.exit(2);
}
const c = { name: slug, ats, slug, enabled: true, ...(process.argv.includes('--eu') ? { region: 'eu' as const } : {}) };
const fetcher = { greenhouse: fetchGreenhouse, lever: fetchLever, ashby: fetchAshby }[ats];
try {
  const jobs = await fetcher(c);
  const { config } = loadPortals();
  const kept = config ? jobs.filter((j) => titlePasses(j.title, config.title_filter) && locationAllowed(j.locations, j.remote, config.location_filter)) : jobs;
  console.log(`${ats} ${slug}: ${jobs.length} jobs on the board, ${kept.length} pass the filters`);
  for (const j of kept.slice(0, 5)) console.log(`  - ${j.title} | ${j.locations.join('; ')} | ${j.apply_url}`);
} catch (e: any) {
  console.error(`${ats} ${slug}: ${e?.message ?? e}`);
  process.exit(1);
}
