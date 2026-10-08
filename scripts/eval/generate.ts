// Generate tailored resumes for the 8 fixture jobs with `claude -p` (subscription auth, no API key).
//   npm run eval:gen -- <outDir> [--system A|B|C] [--jobs id1,id2] [--model <alias-or-id>]
// The model is pinned (default EVAL_DEFAULT_MODEL) and printed at start; record it in the run notes.
// System A uses the CURRENT .claude/skills/tailor-resume/SKILL.md, so a prompt change is measured as-is.
// B and C use the frozen rival prompts in fixtures/prompts/. Runs in a temp cwd with no MCP servers,
// so the generator cannot call tools or read project files; it sees only the prompt.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPrompt, EVAL_DEFAULT_MODEL, rulesFromFrozenPrompt, safeId, stripFrontmatter, type EvalJob } from './lib.js';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const outDir = args[0];
if (!outDir || outDir.startsWith('--')) {
  console.error('usage: npm run eval:gen -- <outDir> [--system A|B|C] [--jobs id1,id2] [--model <alias-or-id>]');
  process.exit(2);
}
const system = (opt('--system') ?? 'A').toUpperCase();
const only = opt('--jobs')?.split(',');
const model = opt('--model') ?? process.env.EVAL_MODEL ?? EVAL_DEFAULT_MODEL;
const jobs: EvalJob[] = JSON.parse(readFileSync(path.join(DIR, 'fixtures', 'jobs.json'), 'utf8')).filter((j: EvalJob) => !only || only.includes(j.id));
const wrapper = readFileSync(path.join(DIR, 'wrapper.md'), 'utf8');
const rules = system === 'A'
  ? stripFrontmatter(readFileSync('.claude/skills/tailor-resume/SKILL.md', 'utf8'))
  : rulesFromFrozenPrompt(readFileSync(path.join(DIR, 'fixtures', 'prompts', `system-${system}.md`), 'utf8'));
const base = readFileSync(path.join(DIR, 'fixtures', 'base-resume.json'), 'utf8');
mkdirSync(outDir, { recursive: true });
console.error(`[eval:gen] model=${model} system=${system} jobs=${jobs.length}`);

function runClaude(prompt: string): Promise<string> {
  const cwd = mkdtempSync(path.join(tmpdir(), 'jobapplier-eval-'));
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--model', model, '--output-format', 'text', '--strict-mcp-config'], { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('claude -p timed out after 600s')); }, 600_000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`claude -p exited ${code}`)); });
    child.stdin.end(prompt);
  });
}

for (const job of jobs) {
  const text = await runClaude(buildPrompt(wrapper, rules, base, job));
  writeFileSync(path.join(outDir, `${system}-${safeId(job.id)}.json`), text);
  console.error(`[eval:gen] ${system} ${job.id} -> ${text.length} chars`);
}
