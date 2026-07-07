# JobApplier

## What this project is

JobApplier is an autonomous job-hunting agent. It fetches new job postings, scores each one
against a base resume, tailors the resume for good matches, finds a verified contact email at
the hiring company, drafts a cold outreach email, and sends it — within strict safety limits.
It runs as a Claude Code agent using MCP tools (`job-fetch`, `resume`, `contacts`, `gmail`) and
two skills (`match-jobs`, `draft-outreach`). Phase 1 only does cold email; no LinkedIn messaging.

The orchestrating session does not call the `job-fetch`/`contacts`/`resume`/`gmail` tools
directly for the hunt pipeline — it dispatches one subagent per pipeline stage (defined in
`.claude/agents/`: `discoverer`, `matcher`, `contact-finder`, `outreach-preparer`, `sender`) via
the Task tool, and only ever sees each stage's compact JSON result. See "Running the hunt"
below.

## Preferences

Edit these to change what the agent hunts for. These are the ONLY lines you should need to
change for day-to-day tuning.

- **Role**: `full stack developer / react`
- **Location**: `india` (remote also acceptable)
- **Remote OK**: yes
- **MATCH_THRESHOLD**: `70` (env var; jobs scoring below this are skipped — see `.env`)
- **SEND_LIMIT_PER_RUN**: `1` (env var; max real emails sent per run — see `.env`)

## Communication

This agent is primarily operated through the **Telegram channel**, not the terminal. Whenever
you are running with the Telegram channel active (i.e. Claude Code was started with
`--channels plugin:telegram@claude-plugins-official`):

- Send the end-of-run summary (see "Report" step below) as a **Telegram message**, not just
  terminal output. If both a terminal and Telegram are available, send to Telegram — that's the
  channel the user actually reads.
- Any question you need the user to answer, any error you can't recover from, and any "needs
  manual contact" or "queued — send limit reached" item should also go to Telegram, so the user
  never has to check a terminal/log to know what happened.
- If Telegram is NOT active (e.g. a plain local run without `--channels`), fall back to printing
  clearly to output as described in the "Report" step below.
- Keep Telegram summaries concise — counts and job titles/companies, not full email bodies or
  raw JSON, unless the user explicitly asks to see one in full.

## Commands

When a message arrives (Telegram or CLI), match it against this table first. Match on intent,
not exact wording — but do not run a stage that wasn't asked for.

| Trigger (examples)                                    | Action                                              |
| ------------------------------------------------------ | --------------------------------------------------- |
| "run hunt", "run the hunt", "find jobs", cron prompt   | Run the full hunt pipeline (below).                  |
| "status", "summary", "how are things"                  | Read current SQLite state (jobs/contacts/outreach counts, no tool side effects) and report it. Do not run any pipeline stage. |
| "apply to job #N", "apply to <company>"                | Phase 2 — not built yet. Reply that Phase 2 (apply) isn't implemented; point to `docs/superpowers/plans/2026-07-07-jobapplier-phase2.md`. |
| "apply all", "apply to today's matches"                | Same — Phase 2 not built yet. |
| "connect <job#/company>"                                | Phase 2 — not built yet. Same pointer. |
| "check replies"                                         | Phase 3 — not built yet. Point to `docs/superpowers/plans/2026-07-07-jobapplier-phase3.md`. |

As Phase 2/3 get implemented, add their commands' real actions here — do not leave this table
silently stale.

## Running the hunt (subagent-per-stage)

When told "run hunt" (see Commands above), run the pipeline below. **You (the orchestrating
session) do not call `job-fetch`, `contacts`, `resume`, or `gmail` tools yourself.** Instead,
dispatch a fresh subagent per stage using the Task tool, so each stage's tool output and
reasoning stay out of your own context — you only see the compact JSON each stage returns. Do
not skip stages. Do not exceed `SEND_LIMIT_PER_RUN` real emails.

1. **Discover** — dispatch `subagent_type: discoverer` with the Role and Location from
   Preferences. It returns a JSON array of new Job objects. If empty, skip to step 6 and report
   zero new jobs.

2. **Match** — dispatch `subagent_type: matcher` with the full job list from step 1. It returns
   `[{job_id, score, reasons, missing_keywords}, ...]` for every job (unfiltered).
   In the orchestrating session (cheap, no tools needed), filter this yourself: any `job_id`
   with `score < MATCH_THRESHOLD` (env var, default 70) is SKIPPED — not contacted, not
   tailored, not drafted. Keep the list of MATCHED job_ids and their full Job objects (from
   step 1) for step 3.

3. **Find contacts** — dispatch `subagent_type: contact-finder` with the list of MATCHED jobs
   from step 2. It returns `[{job_id, contact: {...}|null}, ...]`. Split this yourself:
   - `contact: null` → add to the "needs manual contact" list for the final report; do not
     proceed to step 4 for this job.
   - `contact: {...}` (verified) → keep for step 4.

4. **Prepare outreach** — for EACH job with a verified contact from step 3, dispatch a separate
   `subagent_type: outreach-preparer` call with that one job + its contact + the base resume
   (you may fetch the base resume once yourself via a single lightweight call, or let the first
   preparer subagent fetch it — either is fine since it's read-only). Each call returns
   `{job_id, pdf_path, subject, body, to}`. Collect all of these into one list. These can be
   dispatched one at a time or, if the runtime supports concurrent Task calls, in parallel —
   either way, do not call `gmail.send_email` yourself for any of them.

5. **Send** — dispatch ONE `subagent_type: sender` call with the entire list of prepared items
   from step 4 and the current `SEND_LIMIT_PER_RUN` value. It returns
   `{sent: [...], queued: [...], failed: [...]}`. This is the only stage that ever calls
   `gmail.send_email`, which keeps the per-run cap enforced in exactly one place.

6. **Report** — after all stages complete (or immediately, if step 1 returned zero jobs), deliver
   a clear summary per the "Communication" section above with these exact counts:
   - Total new jobs fetched (step 1).
   - Total jobs matched (step 2, `score >= MATCH_THRESHOLD`).
   - Total emails actually sent (`sent` from step 5).
   - Total jobs "needs manual contact" (step 3), with titles/companies/urls.
   - Total jobs "queued — send limit reached" (`queued` from step 5), with titles/companies.
   - Total "failed" sends (step 5), with titles/companies and the error, if any.

## Resume tailoring rules

When tailoring the base resume JSON for a specific job, follow these rules:

1. Return the SAME JSON schema/shape as the input base resume — same top-level keys, same
   nested structure. Do not add or remove fields.
2. Rewrite experience bullet points to start with a strong action verb (e.g. "Built", "Led",
   "Reduced", "Designed", "Automated") instead of weak openers like "Responsible for" or
   "Worked on".
3. Quantify bullets with numbers ONLY where the original resume already supports that number
   (e.g. team size, percentage improvement, user count). Never invent a metric that isn't
   already present in some form in the base resume.
4. Mirror the job description's exact keywords and technology names wherever the candidate
   genuinely has that skill (e.g. if the JD says "React.js" and the resume says "React", you
   may write "React.js" to match; do not add a technology the candidate has never used).
5. Reorder the skills list so skills mentioned in the job description appear first, most
   relevant to least relevant.
6. NEVER fabricate: company names, job titles held, employment dates, degrees, or metrics that
   have no basis in the base resume. Tailoring is about emphasis and wording, not invention.
7. Adjust the `jobTitle`/headline and `summary` fields (if present in the schema) to speak
   directly to the target role, using truthful language about the candidate's actual
   background.

## Safety

1. Only send email to addresses marked `verified: true` by `contacts.find_company_emails`.
   Never send to an unverified guess.
2. Never exceed `SEND_LIMIT_PER_RUN` real sends via the `gmail` `send_email` tool in a single run. Extra
   matches beyond the limit get queued and reported, not sent.
3. Cold email is the only outreach channel in Phase 1. Do not attempt LinkedIn messages, LinkedIn
   connection requests, or any other outreach channel.
4. If any tool call fails or returns an error, do not retry silently more than once; log the
   failure and continue with the next job rather than aborting the whole run.
