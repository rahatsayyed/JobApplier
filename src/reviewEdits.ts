// file: src/reviewEdits.ts
// Applies a reviewer's structured edits (adapted from MadsLorentzen/ai-job-search /apply steps 3-4, MIT, (c) 2026
// Mads Lorentzen) one at a time and re-runs the fact gate after each, so a reviewer can reword, re-aim or cut, but can
// never add an unsupported claim.
import { checkOutreachText, checkResume, type CheckOptions, type FactReport } from './resumeFacts.js';

export interface ReviewEdit {
  target: 'resume' | 'email';
  path: string; // resume: "summary" | "jobTitle" | "experience[i].description[j]"; email: "subject" | "body"
  old_string: string;
  new_string: string;
  reason: 'keyword' | 'reframing' | 'style' | 'grounding' | 'cut' | 'fact-gate';
}
export interface EmailDraft { subject: string; body: string }
export interface ReviewApplyResult {
  resume: any;
  email: EmailDraft | null;
  applied: ReviewEdit[];
  rejected: Array<{ edit: ReviewEdit; why: string }>;
  facts: FactReport;
  emailFacts: FactReport | null;
}

const MAX_EDITS = 20;
const RESUME_PATH = /^(?:(summary|jobTitle)|experience\[(\d+)\]\.description\[(\d+)\])$/;

function occurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}
function blockSet(r: FactReport): Set<string> {
  return new Set([...r.invented, ...r.unsupported.map((u) => u.replace(/ @\S+$/, '')), ...r.forbidden.map((f) => `forbidden:${f}`)]);
}
function replaceOnce(current: string, edit: ReviewEdit): { value: string } | { error: string } {
  if (edit.old_string === '' && current.trim() === '') return { value: edit.new_string };
  const n = occurrences(current, edit.old_string);
  if (n === 0) return { error: 'old_string not found at path' };
  if (n > 1) return { error: `old_string is not unique at path (${n} matches)` };
  return { value: current.replace(edit.old_string, () => edit.new_string) };
}

export function applyResumeEdit(resume: any, edit: ReviewEdit): { resume: any } | { error: string } {
  const m = RESUME_PATH.exec(edit.path ?? '');
  if (!m) return { error: `unsupported path "${edit.path}"` };
  const out = JSON.parse(JSON.stringify(resume));
  if (m[1]) {
    const r = replaceOnce(typeof out[m[1]] === 'string' ? out[m[1]] : '', edit);
    if ('error' in r) return r;
    out[m[1]] = r.value;
    return { resume: out };
  }
  const list = out.experience?.[Number(m[2])]?.description;
  const i = Number(m[3]);
  if (!Array.isArray(list) || typeof list[i] !== 'string') return { error: `no bullet at ${edit.path}` };
  if (edit.reason === 'cut' && edit.new_string === '') {
    if (list[i].trim() !== edit.old_string.trim()) return { error: 'cut must quote the whole bullet as old_string' };
    list.splice(i, 1);
    return { resume: out };
  }
  const r = replaceOnce(list[i], edit);
  if ('error' in r) return r;
  list[i] = r.value;
  return { resume: out };
}

export function applyReviewEdits(
  base: any,
  resume: any,
  email: EmailDraft | null,
  edits: ReviewEdit[],
  opts: CheckOptions = {},
): ReviewApplyResult {
  let cur = JSON.parse(JSON.stringify(resume));
  let curEmail = email ? { ...email } : null;
  const emailText = (e: EmailDraft) => `${e.subject}\n\n${e.body}`;
  let resumeBlocks = blockSet(checkResume(base, cur, opts));
  let emailBlocks = curEmail ? blockSet(checkOutreachText(emailText(curEmail), base, opts)) : new Set<string>();
  const applied: ReviewEdit[] = [];
  const rejected: Array<{ edit: ReviewEdit; why: string }> = [];
  // Order (P3): every non-cut edit first, in the reviewer's order, against the ORIGINAL indices (nothing has shifted yet);
  // then the cuts, highest index first, so one cut never shifts the path of the next. Cutting first would let a non-cut edit
  // written for bullet [1] land on whatever bullet slid into [1].
  const ordered = [...edits.slice(0, MAX_EDITS)].sort((a, b) => {
    const ka = a.reason === 'cut' ? 1 : 0;
    const kb = b.reason === 'cut' ? 1 : 0;
    return ka - kb || (ka === 1 ? b.path.localeCompare(a.path, undefined, { numeric: true }) : 0);
  });
  for (const edit of ordered) {
    if (edit.target === 'resume') {
      const r = applyResumeEdit(cur, edit);
      if ('error' in r) { rejected.push({ edit, why: r.error }); continue; }
      const next = blockSet(checkResume(base, r.resume, opts));
      const added = [...next].filter((b) => !resumeBlocks.has(b));
      if (added.length) { rejected.push({ edit, why: `would add unsupported claim(s): ${added.join(', ')}` }); continue; }
      cur = r.resume;
      resumeBlocks = next;
      applied.push(edit);
    } else if (edit.target === 'email') {
      if (!curEmail) { rejected.push({ edit, why: 'no email draft to edit' }); continue; }
      if (edit.path !== 'subject' && edit.path !== 'body') { rejected.push({ edit, why: `unsupported path "${edit.path}"` }); continue; }
      const r = replaceOnce(curEmail[edit.path], edit);
      if ('error' in r) { rejected.push({ edit, why: r.error }); continue; }
      const candidate = { ...curEmail, [edit.path]: r.value };
      const next = blockSet(checkOutreachText(emailText(candidate), base, opts));
      const added = [...next].filter((b) => !emailBlocks.has(b));
      if (added.length) { rejected.push({ edit, why: `would add unsupported claim(s): ${added.join(', ')}` }); continue; }
      curEmail = candidate;
      emailBlocks = next;
      applied.push(edit);
    } else {
      rejected.push({ edit, why: `unknown target "${(edit as any).target}"` });
    }
  }
  return {
    resume: cur,
    email: curEmail,
    applied,
    rejected,
    facts: checkResume(base, cur, opts),
    emailFacts: curEmail ? checkOutreachText(emailText(curEmail), base, opts) : null,
  };
}
