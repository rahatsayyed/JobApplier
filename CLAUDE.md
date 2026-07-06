# JobApplier

## What this project is

JobApplier is an autonomous job-hunting agent. It fetches new job postings, scores each one
against a base resume, tailors the resume for good matches, finds a verified contact email at
the hiring company, drafts a cold outreach email, and sends it — within strict safety limits.
It runs as a Claude Code agent using MCP tools (`job-fetch`, `resume`, `contacts`, `gmail`) and
two skills (`match-jobs`, `draft-outreach`). Phase 1 only does cold email; no LinkedIn messaging.

## Preferences

Edit these to change what the agent hunts for. These are the ONLY lines you should need to
change for day-to-day tuning.

- **Role**: `full stack developer / react`
- **Location**: `india` (remote also acceptable)
- **Remote OK**: yes
- **MATCH_THRESHOLD**: `70` (env var; jobs scoring below this are skipped — see `.env`)
- **SEND_LIMIT_PER_RUN**: `1` (env var; max real emails sent per run — see `.env`)

## Running the hunt

When told "run the hunt" (or triggered by the scheduled/cron prompt), follow this procedure
EXACTLY, in order. Do not skip steps. Do not send more than `SEND_LIMIT_PER_RUN` real emails.

1. Call `job-fetch.list_new_jobs({role, location})` using the Role and Location from the
   Preferences block above. This returns a JSON array of new Job objects
   `{id, source, title, company, url, apply_url, description}` that have not been seen before.
   If the array is empty, skip straight to step 8 and report zero new jobs.

2. Call `resume.get_base_resume()` ONCE. Keep this base resume JSON in memory — do not call it
   again for each job.

3. For EACH job returned in step 1, in order:
   a. Invoke the `match-jobs` skill with the job and the base resume JSON. It returns
      `{score, reasons, missing_keywords}`.
   b. If `score < MATCH_THRESHOLD` (read the `MATCH_THRESHOLD` env var; default 70 if unset),
      SKIP this job — do not contact, do not tailor a resume, do not draft anything. Move to
      the next job.
   c. If `score >= MATCH_THRESHOLD`, this job is a MATCH — continue to step 4 for this job.

4. For each MATCHED job:
   a. Call `contacts.find_company_emails({company: job.company, domain?: <company domain if known>})`.
      This returns a ranked array of `{email, type, verified, source, confidence}`.
   b. If there is NO entry with `verified: true` in the result, DO NOT send any email for this
      job. Add the job (title, company, url) to a "needs manual contact" list to include in the
      final report, and move on to the next matched job — do not proceed to steps 5-7 for it.
   c. If there IS at least one `verified: true` entry, take the highest-confidence verified one
      as the "top verified contact" and continue to step 5 for this job.

5. Tailor the base resume JSON to this job following the "Resume tailoring rules" below. Then
   call `resume.render_resume({resume_json: <tailored resume>})`, which returns `{pdf_path}`.
   Keep this `pdf_path` for step 7.

6. Invoke the `draft-outreach` skill with the job, a short summary of the tailored resume, and
   the top verified contact from step 4c. It returns `{subject, body}`.

7. If the number of real emails already sent in this run is LESS THAN `SEND_LIMIT_PER_RUN`:
   send via the `gmail` MCP `send_email` tool — to the top verified contact's email, with the
   subject and body from step 6, and the tailored PDF (`pdf_path` from step 5) attached. Consult
   the tool's input schema for the exact field names (e.g. `to`, `subject`, `body`, `attachments`).
   Increment the sent count.
   If the number of real emails already sent in this run has REACHED `SEND_LIMIT_PER_RUN`:
   do NOT call `email.send_email`. Instead add this job (title, company, contact email,
   subject, body) to a "queued — send limit reached" list for the report. Do not draft further
   emails once queued jobs are just being logged — still run steps 5-6 for every match so the
   report is complete, only step 7's actual send is gated by the limit.

8. After all jobs from step 1 have been processed, print a clear summary to output with these
   exact counts:
   - Total new jobs fetched (from step 1).
   - Total jobs matched (score >= MATCH_THRESHOLD).
   - Total emails actually sent (real sends in step 7).
   - Total jobs in the "needs manual contact" list (from step 4b), with their titles/companies/urls.
   - Total jobs "queued — send limit reached" (from step 7), with their titles/companies.
   This is printed directly to output for now. In a later phase this summary will instead be
   sent as a Telegram message — do not build that integration yet, just print clearly.

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
