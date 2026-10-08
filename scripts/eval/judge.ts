// Blind-judge a candidate run against frozen baselines with `claude -p`.
//   npm run eval:judge -- <candDir> [--compare A,C] [--model <alias-or-id>]
// The judge model is pinned (default EVAL_DEFAULT_MODEL) and printed at start.
// <candDir> must hold A-<job>.json files (the new system). Each packet mixes NEW + the --compare baselines,
// shuffled with a fixed seed; the label->system key is written next to the verdicts and never shown to the judge.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EVAL_DEFAULT_MODEL, parseLoose, resumeAsText, safeId, seededShuffle, summarizeVerdicts, type EvalJob, type Verdict } from './lib.js';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const cand = args[0];
if (!cand || cand.startsWith('--')) {
  console.error('usage: npm run eval:judge -- <candDir> [--compare A,C] [--model <alias-or-id>]');
  process.exit(2);
}
const compare = (opt('--compare') ?? 'A,C').split(',').map((s) => s.trim().toUpperCase());
const model = opt('--model') ?? process.env.EVAL_MODEL ?? EVAL_DEFAULT_MODEL;
const jobs: EvalJob[] = JSON.parse(readFileSync(path.join(DIR, 'fixtures', 'jobs.json'), 'utf8'));
const base = JSON.parse(readFileSync(path.join(DIR, 'fixtures', 'base-resume.json'), 'utf8'));
const rubric = readFileSync(path.join(DIR, 'judge-rubric.md'), 'utf8');
const outDir = path.join(cand, 'judge');
mkdirSync(outDir, { recursive: true });
console.error(`[eval:judge] model=${model} compare=${compare.join(',')}`);

function runClaude(prompt: string): Promise<string> {
  const cwd = mkdtempSync(path.join(tmpdir(), 'jobapplier-judge-'));
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--model', model, '--output-format', 'text', '--strict-mcp-config'], { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('judge timed out after 600s')); }, 600_000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`claude -p exited ${code}`)); });
    child.stdin.end(prompt);
  });
}

const key: Record<string, Record<string, string>> = {};
const verdicts: Verdict[] = [];
for (const [i, job] of jobs.entries()) {
  const entries = [
    { sys: 'NEW', file: path.join(cand, `A-${safeId(job.id)}.json`) },
    ...compare.map((s) => ({ sys: `BASE_${s}`, file: path.join(DIR, 'fixtures', 'baseline', `${s}-${safeId(job.id)}.json`) })),
  ];
  const order = seededShuffle(entries, 20261008 + i);
  key[job.id] = {};
  const parts = order.map((e, k) => {
    const label = `Resume ${k + 1}`;
    key[job.id][label] = e.sys;
    return `### ${label}\n\n${resumeAsText(parseLoose(readFileSync(e.file, 'utf8')))}`;
  });
  const packet = [
    `## Job posting\nJob id: ${job.id}\nTitle: ${job.title}\nCompany: ${job.company}\n\n${job.description}`,
    `## Candidate's ORIGINAL resume, the only source of truth for facts\n\n${resumeAsText(base)}`,
    `## Tailored versions (anonymous, random order)\n\n${parts.join('\n\n')}`,
  ].join('\n\n');
  const v = parseLoose(await runClaude(`${rubric}\n\n${packet}`)) as Verdict;
  v.job = job.id;
  verdicts.push(v);
  writeFileSync(path.join(outDir, `verdict-${safeId(job.id)}.json`), JSON.stringify(v));
  console.error(`[eval:judge] ${job.id} done`);
}
writeFileSync(path.join(outDir, 'key.json'), JSON.stringify(key, null, 2));
const summary = summarizeVerdicts(verdicts, key);
const cols = ['n', 'truthfulness', 'jobFit', 'bulletQuality', 'voice', 'skimmability', 'sendCount', 'avgRank', 'violations'] as const;
const md = [`| system | ${cols.join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`,
  ...Object.entries(summary).map(([s, r]) => `| ${s} | ${cols.map((c) => r[c]).join(' | ')} |`)].join('\n');
writeFileSync(path.join(outDir, 'summary.md'), md + '\n');
console.error(md);
