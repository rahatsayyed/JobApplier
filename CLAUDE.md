# JobApplier

## What this project is

JobApplier is an autonomous job-hunting agent. It fetches new job postings, scores each one
against a base resume, tailors the resume for good matches, finds a verified contact email at
the hiring company, drafts a cold outreach email, and sends it — within strict safety limits.
Phase 2 adds opt-in LinkedIn Easy Apply (burner account), external ATS apply (Greenhouse/Lever/
Workday/Ashby), and human-approved LinkedIn connection requests (main account) on top of the
Phase 1 pipeline. It runs as a Claude Code agent using MCP tools (`job-fetch`, `resume`,
`contacts`, `gmail`, `linkedin-apply`, `external-apply`, `connect`) and skills (`match-jobs`,
`draft-outreach`, `draft-connect-note`).

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

## Context & Subagent Discipline

- Default to offloading heavy exploration, research, and multi-file investigation to subagents
  (the Agent tool — use `fork` when the task benefits from shared conversation context, or a
  fresh subagent for independent research) rather than doing it inline in the main thread. This
  keeps the main thread's context usage low.
- Self-monitor context usage during the session. If context is getting high while a task is in
  progress, finish that task before suggesting compaction — don't interrupt mid-task.
- If a new task is about to start and context is already elevated, proactively flag that
  compacting first might be worth it if the new task looks like it will consume significant
  context.
- Note: Claude Code has no native percentage-based or task-boundary-aware auto-compact setting
  (only `autoCompactWindow`, a raw token threshold with no task awareness) — this is a
  behavioral convention to follow manually, not something enforced by a hook or config.

## Communication

This agent is primarily operated through the **Telegram channel**. Whenever you are running with
the Telegram channel active (i.e. Claude Code was started with
`--channels plugin:telegram@claude-plugins-official`):

**Every command → Telegram response:**
- Every message the user sends (run hunt, status, apply, etc.) gets an immediate response back
  to Telegram. Never go silent — always reply, even if it's "working..." or "error: ...".
- ALWAYS invoke the `telegram-format` skill on any response text before sending it via the
  Telegram reply tool — this converts markdown to Telegram HTML so bold, italic, lists, code,
  and links render correctly (not as raw markdown).

**Long-running tasks → mid-task progress updates:**
- If a task will take more than ~30 seconds (e.g., discovering 50 jobs, matching them, finding
  contacts), post progress updates to Telegram mid-run (e.g., "Discovered 50 jobs, matching...",
  then "Matched 10, finding contacts...", then "Sent 1 email").
- This keeps the user informed and confirms the agent is still running, not frozen.

**Final summaries:**
- After all stages complete, post the full summary to Telegram (counts, job titles, any manual
  contact flags or failures).
- If both a terminal and Telegram are available, prioritize Telegram — that's the channel the
  user actually reads.

**Error handling:**
- Any question you need the user to answer → Telegram.
- Any error you can't recover from → Telegram (log + ask for guidance).
- "Needs manual contact" or "queued — send limit reached" items → Telegram (never silent).

**Fallback (no Telegram):**
- If Telegram is NOT active (e.g., a plain local run without `--channels`), print clearly to
  output instead.

**Keep summaries concise:**
- Counts, job titles, companies — not full email bodies or raw JSON, unless the user explicitly
  asks.

## Commands

When a message arrives (Telegram or CLI), match it against this table first. **Telegram slash commands** (e.g., `/runhunt`) are preferred and more reliable; natural language fallbacks are supported but less precise.

| Trigger | Action |
|---------|--------|
| `/runhunt` or "run hunt", "find jobs" | Run the full hunt pipeline (below). |
| `/status` or "status", "summary" | Query SQLite: count of jobs (total/matched/by-source), outreach (sent/queued/failed), etc. No side effects, instant response. |
| `/followups` | Phase 1.5 — send follow-up nudges to old sent emails (if implemented). |
| `/apply #N` or "apply to job #N" | Apply to one matched job (see "Applying" below). |
| `/applyall` | Apply to all of today's matched jobs (see "Applying" below). |
| `/connect` | Draft and (with approval) send a LinkedIn connection request for a matched job (see "Connecting" below). |
| `/checkreplies` | Phase 3 — not built yet. Reply with link to Phase 3 plan. |

**Setting up Telegram slash commands** (one-time, via BotFather):
1. Message @BotFather on Telegram.
2. Select your bot, then `/setcommands`.
3. Paste this list (one per line):
   ```
   runhunt - Discover jobs, match, find contacts, send cold emails
   status - Show job/outreach/thread stats
   followups - Send follow-up nudges (Phase 1.5)
   apply - Apply to a job (Easy Apply or external ATS)
   connect - Draft + (with approval) send a LinkedIn connect request
   checkreplies - Check replies (Phase 3 — not yet)
   ```

As Phase 2/3 get implemented, update BotFather's command list and this table — do not leave
commands silently stale.

## Status Command

When told `/status` or "show status", query the SQLite MCP for stats (no tool side effects, instant):

1. Call `sqlite.get_job_stats()` → returns total, by_status, by_source.
2. Call `sqlite.get_outreach_stats()` → returns total, by_status, by_month.
3. Format a concise summary:
   ```
   📊 Job Stats
   • Total discovered: N
   • Matched (≥70): M
   • By source: Adzuna X, Remotive Y, RemoteOK Z

   📧 Outreach Stats
   • Sent: N
   • Queued (limit reached): M
   • Failed: K
   • Last sent: [date]
   ```
4. Post to Telegram. No other action.

---

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

## Applying (Phase 2)

Applying is a **separate, opt-in** flow from "Running the hunt" — it is **never** implicitly
bundled into the Phase 1 email-hunt pipeline. It only runs when:
- explicitly triggered by command (`/apply #N`, `/applyall`, "apply to job #N", "apply to today's
  matches"), or
- the cron/autonomous trigger fires AND `AUTO_APPLY_ENABLED=true` (env var, default `false`).

An explicit manual command may still invoke applying regardless of `AUTO_APPLY_ENABLED` — that
flag only gates the *autonomous* (cron) path. Manual applies are still subject to the daily rate
limits below.

Steps, for each targeted job:

1. Look up the job's `apply_url`. If it's a LinkedIn Easy Apply posting, dispatch to
   `linkedin-apply.apply_easy_apply({job_id})`. Otherwise (Greenhouse/Lever/Workday/Ashby or other
   external ATS), dispatch to `external-apply.apply_external({job_id})`.
2. Each call returns one of: `submitted`, `manual_review` (a genuinely unrecoverable case —
   missing burner/main session, no Easy Apply button, no submit control found, or a submit
   click that couldn't be confirmed — never a guessed submission), `needs_answer` (a screening
   question `apply_easy_apply` can't answer from `config/easy-apply-answers.json` — see step 2a
   below), or `rate_limited` (daily `MAX_APPLIES_PER_DAY` cap reached — report it, do not
   retry). `apply_easy_apply` and `apply_external` share the SAME daily counter, so an apply of
   either kind can trip this. `apply_external` also returns `manual_review` if it clicked
   submit but couldn't confirm the application was recorded (the same false-positive class of
   bug fixed in `apply_easy_apply` — a click can silently no-op) — its confirmation check is a
   best-effort heuristic (common confirmation copy), NOT live-verified against a real
   Greenhouse/Lever/Workday/Ashby posting yet, unlike `apply_easy_apply`'s.
2a. On `needs_answer` (the result includes the exact `question` text verbatim from the
    posting):
    - Determine a truthful value for that question from the candidate's actual, documented
      background (the base resume, or an answer already present in
      `config/easy-apply-answers.json`). **Never invent a plausible-sounding number or fact** —
      if you cannot verify the value truthfully, ask the user for it (Telegram if active, else
      chat) rather than guessing.
    - Add it to `config/easy-apply-answers.json` under the `custom` object, keyed by the
      question text **verbatim** (matching is case/whitespace-insensitive and tolerates a
      trailing `*`, but the key should still read like the real question for future reuse),
      e.g. `"custom": { "What is your current CTC?": "18 LPA" }`.
    - `config/easy-apply-answers.json` is re-read from disk on every `apply_easy_apply` call
      (`loadAnswers()` calls `readFileSync` fresh each time), so no MCP reconnect is needed for
      this specific edit — you can retry the apply immediately after writing the `custom` entry.
      (An MCP reconnect is only needed if `linkedin-apply.ts`'s own source changes.)
    - Still inform the user (Telegram if active, else chat) what question blocked the apply, what
      value you added and where it came from (resume / existing config / user-provided), before
      retrying — this is real personal data going into a real application, not a silent action.
3. Report results per job to Telegram per the "Communication" section: submitted / needs manual
   review / needs an answer (with the question) / rate-limited, with job title + company for
   each.

Do not call `linkedin-apply` or `external-apply` tools directly yourself for this flow if a
dedicated subagent exists for the stage — otherwise call them directly, since Applying is
single-job-at-a-time and doesn't need the multi-stage pipeline "Running the hunt" uses.

### Hybrid Claude fallback (Easy Apply + external ATS, opt-in)

Hardcoded Playwright selectors are the fast, free default path and run first on every step, in
both `linkedin-apply.ts` and `external-apply.ts`. LinkedIn's DOM is not stable the way
Greenhouse/Lever/Workday/Ashby's is, so selector rot happens there most; rather than
dead-ending at `manual_review`/`needs_answer` on every selector miss, a bounded Claude
escalation can kick in — only on failure, never on every step:
- **Control click miss** — `linkedin-apply.ts`: Easy Apply button, or Next/Review/Submit not
  found. `external-apply.ts`: submit button not found (required-field selectors —
  name/email/resumeUpload — are NOT covered; those platforms' field IDs are documented as far
  more stable than LinkedIn's, and finding the right field is different work than picking a
  button to click). Escalates with the real, currently-visible button/link texts on the page
  and picks one — or refuses if none plausibly match. Never invents text that isn't actually on
  the page.
- **Unanswerable screening question** (`linkedin-apply.ts` only — external ATS forms in this
  codebase have no dynamic Q&A schema): escalates with the question text and the candidate's
  existing truthful answer topics (the fixed fields + the `custom` map), asking only whether
  the question is a *rephrasing* of one already answered. Never invents a new value — if the
  question asks for genuinely new information, it still falls through to `needs_answer` (step
  2a above).

Opt-in per file, off by default: `EASY_APPLY_HYBRID_FALLBACK=true` for `linkedin-apply.ts`,
`EXTERNAL_APPLY_HYBRID_FALLBACK=true` for `external-apply.ts` — these are independent toggles,
not shared.

This project has no separate Anthropic API key/billing — the user has a Claude subscription,
not API credits — so this fallback shells out to the `claude` CLI in headless print mode,
invoking one of two project-level custom slash commands rather than an ad hoc inline prompt:
`.claude/commands/easy-apply-control-fallback.md` (control-click escalation, shared by both
files) and `.claude/commands/easy-apply-answer-fallback.md` (screening-question escalation,
`linkedin-apply.ts` only). Keeping the task, output contract, and "never invent" rules in those
files means Claude already knows the exact steps on every invocation instead of the caller
re-deriving them in a fresh prompt each time. Each call authenticates via the same Claude Code
subscription session (not a metered API key) and is a single, isolated, non-agentic invocation
— no follow-up turns, no tool use.

None of `external-apply.ts`'s new confirmation-check/fallback behavior has been live-tested
against a real Greenhouse/Lever/Workday/Ashby posting yet — same caveat as the rest of Phase
2's untested-live gaps (see "Connecting" below for the equivalent `connect.ts` caveat).

## Connecting (Phase 2, human-gated)

For a matched job (with or without a sent cold email):

1. Call `connect.find_linkedin_profile({company, role_hint})` → top 3 candidate profiles.
2. Invoke the `draft-connect-note` skill with the job and the chosen candidate profile → a
   drafted note (≤300 chars).
3. **Post the drafted note to Telegram and STOP.** Do not call `connect.connect_send` in this
   turn. Optionally call `connect.record_connection_status({profile_url, note, status: 'drafted',
   job_id, company})` to record the draft (pure bookkeeping write, no side effects). Wait for the
   user's next message.
4. On the user's next reply, matched to this pending draft (e.g. by job/company name):
   - `send` (or equivalent approval) → call `connect.connect_send({profile_url, note})` now, for
     the first time, in response to this explicit approval.
   - `edit: <changes>` → redraft per the requested changes, re-post to Telegram, and wait again
     (do not send the edited version without a fresh approval).
   - `skip` or anything else non-approving → call
     `connect.record_connection_status({profile_url, note, status: 'skipped', job_id, company})`
     to mark the connection `status='skipped'` in the DB, then move on; do not send.
5. If `connect_send` reports `rate_limited` (daily `MAX_CONNECTS_PER_DAY` cap reached), report
   that to Telegram and stop — do not retry later in the same run.

### `connect_send` reliability

`connect_send` now verifies its final Send click actually went through (waits for the invite
dialog to dismiss) before reporting `sent` — a click that silently no-ops now correctly returns
`failed` instead of a false `sent`, the same false-positive class of bug fixed in
`apply_easy_apply`. **This confirmation signal is best-effort, NOT live-verified** — unlike
this file's already-live-verified moreButton/connectMenuItem/sendButton selectors, sending a
real request to verify it requires explicit human approval that hasn't been given yet. The
next real, approved `connect_send` should be watched to confirm the heuristic actually fires,
and ideally identify a more specific signal (e.g. exact toast/snackbar text) the way
`linkedin-apply.ts`'s submission confirmation was live-verified.

`connect_send`'s own selector-miss points (More button, Connect menu item, Send button) can
also escalate to the same bounded Claude fallback described above, gated by
`CONNECT_HYBRID_FALLBACK=true` (off by default, independent of the other two flags).

## Resume tailoring rules

Resume tailoring (schema preservation, no fabrication, keyword mirroring, one-page trim with an
~85%-full target, and a mandatory humanizer pass with no em dashes) is fully specified in the
`tailor-resume` skill (`.claude/skills/tailor-resume/SKILL.md`) — that skill is the single
source of truth. Any flow that needs a tailored resume (the hunt pipeline's `outreach-preparer`
stage, or an ad hoc single-job request) should invoke that skill rather than re-deriving these
rules inline, so a future change only needs to happen in one place.

## Safety

1. Only send email to addresses marked `verified: true` by `contacts.find_company_emails`.
   Never send to an unverified guess.
2. Never exceed `SEND_LIMIT_PER_RUN` real sends via the `gmail` `send_email` tool in a single run. Extra
   matches beyond the limit get queued and reported, not sent.
3. In the "Running the hunt" pipeline (Phase 1 email flow), cold email is the only outreach
   channel — do not attempt LinkedIn messages, connection requests, or any other channel as part
   of that flow. LinkedIn connection requests are only ever sent via the separate, human-gated
   "Connecting" flow below (rule 5), never bundled into a hunt run.
4. If any tool call fails or returns an error, do not retry silently more than once; log the
   failure and continue with the next job rather than aborting the whole run.
5. Never call `connect_send` without a `send` approval reply logged in the same conversation.
6. Never use the burner account's session for `connect`/`find_linkedin_profile`, and never use
   the main account's session for `apply_easy_apply`.
7. Respect `MAX_APPLIES_PER_DAY` / `MAX_CONNECTS_PER_DAY` — stop and report "limit reached" rather
   than erroring or retrying.
