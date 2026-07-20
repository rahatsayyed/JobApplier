# JobApplier

## What this project is

JobApplier is an autonomous job-hunting agent. It fetches new job postings, scores each one
against a base resume, tailors the resume for good matches, finds a verified contact email at
the hiring company, drafts a cold outreach email, and sends it — within strict safety limits.
Phase 2 adds LinkedIn Easy Apply (burner account), external ATS apply (Greenhouse/Lever/
Workday/Ashby), and LinkedIn connection requests (main account) on top of the
Phase 1 pipeline — both now run automatically as part of every hunt run, per the "Applying" and
"Connecting" sections below. It runs as a Claude Code agent using MCP tools (`job-fetch`, `resume`,
`contacts`, `gmail`, `apply`, `connect`) and skills (`match-jobs`, `draft-outreach`,
`draft-connect-note`). `apply` is one MCP server exposing both a per-platform tool for each
target — `apply.linkedin`, `apply.greenhouse`, `apply.lever`, `apply.workday`, `apply.ashby` —
and a single `apply.auto({apply_url, job_id})` router tool that inspects `apply_url` and
internally dispatches to the matching platform tool, so callers don't have to pick a tool by
name. The router does not reimplement platform logic — it's a thin dispatcher over the same
per-platform tools, so there is one source of truth per platform, not two. Prefer `apply.auto`
for the common case; call a specific `apply.<platform>` tool directly only when you need to
force a platform or debug one in isolation. Both are backed by `src/apply/linkedin.ts` (Easy
Apply, burner account) and `src/apply/external.ts` (the other four, auto-detected from
`apply_url` with a platform-match safety check).

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
- **MATCH_THRESHOLD**: `60` (env var; jobs scoring below this are skipped — see `.env`)
- **SEND_LIMIT_PER_RUN**: `1` (env var; max real emails — enforced as a daily counter via
  `db.check_and_increment`, not literally reset per invocation, so two hunt runs in the same day
  share the same budget — see `.env`)

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
| `/status` or "status", "summary" | Query the `db` MCP: count of jobs (total/matched/by-source), outreach (sent/queued/failed), etc. No side effects, instant response. |
| `/followups` | Phase 1.5 — send follow-up nudges to old sent emails (if implemented). |
| `/apply #N` or "apply to job #N" | Apply to one matched job (see "Applying" below). |
| `/applyall` | Apply to all of today's matched jobs (see "Applying" below). |
| `/connect` | Draft and send a LinkedIn connection request for a matched job (see "Connecting" below). |
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
   connect - Draft + send a LinkedIn connect request
   checkreplies - Check replies (Phase 3 — not yet)
   ```

As Phase 2/3 get implemented, update BotFather's command list and this table — do not leave
commands silently stale.

## Status Command

When told `/status` or "show status", query the `db` MCP for stats (no tool side effects, instant):

1. Call `db.get_job_stats()` → returns total, by_status, by_source.
2. Call `db.get_outreach_stats()` → returns total, by_status, by_month.
3. Format a concise summary:
   ```
   📊 Job Stats
   • Total discovered: N
   • Matched (≥60): M
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
not skip stages. Do not exceed `SEND_LIMIT_PER_RUN` real emails (enforced as a daily counter —
see "Safety" rule 2).

1. **Discover** — dispatch `subagent_type: discoverer` with the Role and Location from
   Preferences. It calls `job-fetch.list_new_jobs` (Adzuna/Remotive/RemoteOK) plus
   `discover.linkedin_jobs` and `discover.linkedin_posts` (LinkedIn job search + hiring-post
   search, burner account, see `docs/superpowers/specs/2026-07-17-linkedin-discovery-design.md`),
   and returns the combined JSON array of new Job objects. If empty, skip to step 6 and report
   zero new jobs.

   Neither `discover.linkedin_jobs` nor `discover.linkedin_posts` has been live-tested against
   real LinkedIn search results yet — selectors were written from the design spec, not verified
   live. The first real hunt run after this lands should be watched closely (check the
   `[discover]` console logs for parsed/skipped counts) before trusting it unattended.

2. **Match** — dispatch `subagent_type: matcher` with the full job list from step 1. It returns
   `[{job_id, score, reasons, missing_keywords}, ...]` for every job (unfiltered).
   In the orchestrating session (cheap, no tools needed), filter this yourself: any `job_id`
   with `score < MATCH_THRESHOLD` (env var, default 60) is SKIPPED — not contacted, not
   tailored, not drafted. Keep the list of MATCHED job_ids and their full Job objects (from
   step 1) for step 3.

3. **Find contacts + LinkedIn profiles** — dispatch `subagent_type: contact-finder` with the
   list of MATCHED jobs from step 2. It returns
   `[{job_id, contact: {...}|null, linkedin_profiles: [{profile, category}, ...]}, ...]` — a
   verified email contact and up to two LinkedIn profiles (recruiter category, peer category)
   per job. A job with neither a contact nor any profile gets no further stages.

4. **Prepare** — for EACH job with a contact and/or at least one LinkedIn profile from step 3,
   dispatch a separate `subagent_type: outreach-preparer` call with that one job + its
   contact-finder result + the base resume (fetch it once yourself, or let the first preparer
   fetch it — either is fine, read-only). These can be dispatched in parallel — each call tailors
   the resume, drafts the email and connect note(s), and enqueues everything to
   `outreach_queue` itself; it does not return content to you, only a small confirmation. You do
   not collect a batch to hand to the next stage — the queue is the handoff.

5. **Execute** — dispatch ONE `subagent_type: sender` call with the current `SEND_LIMIT_PER_RUN`
   value. It reads the full `outreach_queue` backlog (including anything left over from a
   previous run) and executes email sends, connect sends, and applies, prompting Telegram if it
   hits a daily cap mid-run (see "Connecting" and "Applying" below for what changed). Returns
   `{email: {...}, connect: {...}, apply: {...}}`.

6. **Report** — after all stages complete (or immediately, if step 1 returned zero jobs), deliver
   a clear summary per the "Communication" section above with these counts:
   - Total new jobs fetched (step 1).
   - Total jobs matched (step 2, `score >= MATCH_THRESHOLD`).
   - Emails sent/failed/queued, connects sent/failed/queued, applies
     submitted/manual_review/needs_answer/failed/queued (step 5).
   - Total jobs with no usable contact or profile at all (step 3), with titles/companies/urls.

## Applying (Phase 2)

Applying is now an unconditional part of every hunt run's "Execute" stage (see "Running the
hunt" step 5) — there is no `AUTO_APPLY_ENABLED` opt-in gate anymore. This was an explicit,
informed decision, made alongside the "Connecting" change above; a more granular flag/control
scheme may be reintroduced later as separate work, not designed here.

The manual on-demand `/apply #N` and `/applyall` commands (apply to one or all of today's
matches, outside a hunt run) are unaffected by this and remain available. Manual applies are
still subject to the daily rate limits below.

Steps, for each targeted job:

1. Look up the job's `apply_url` and pick the matching `apply` tool from its domain: LinkedIn
   Easy Apply → `apply.linkedin({job_id})`; `greenhouse.io` → `apply.greenhouse({job_id})`;
   `lever.co` → `apply.lever({job_id})`; a Workday domain → `apply.workday({job_id})`;
   `ashbyhq.com` → `apply.ashby({job_id})`. Each of the four external-ATS tools also
   re-detects the platform from `apply_url` itself and refuses with `manual_review` if it
   doesn't match the tool you called (e.g. you called `apply.lever` but the URL resolved to
   Greenhouse) — so a wrong guess fails safe instead of applying through the wrong flow.
2. Each call returns one of: `submitted`, `manual_review` (a genuinely unrecoverable case —
   missing burner/main session, no Easy Apply button, no submit control found, a platform
   mismatch per above, or a submit click that couldn't be confirmed — never a guessed
   submission), `needs_answer` (a screening question `apply.linkedin` can't answer from
   `config/easy-apply-answers.json` — see step 2a below), or `rate_limited` (daily
   `MAX_APPLIES_PER_DAY` cap reached — report it, do not retry). All five `apply` tools share
   the SAME daily counter, so an apply of any kind can trip this. The four external-ATS tools
   also return `manual_review` if they clicked submit but couldn't confirm the application was
   recorded (the same false-positive class of bug fixed in `apply.linkedin`'s flow — a click can
   silently no-op) — that confirmation check is a best-effort heuristic (common confirmation
   copy), NOT live-verified against a real Greenhouse/Lever/Workday/Ashby posting yet, unlike
   `apply.linkedin`'s.
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
    - `config/easy-apply-answers.json` is re-read from disk on every `apply.linkedin` call
      (`loadAnswers()` calls `readFileSync` fresh each time), so no MCP reconnect is needed for
      this specific edit — you can retry the apply immediately after writing the `custom` entry.
      (An MCP reconnect is only needed if `linkedin.ts`'s own source changes.)
    - Still inform the user (Telegram if active, else chat) what question blocked the apply, what
      value you added and where it came from (resume / existing config / user-provided), before
      retrying — this is real personal data going into a real application, not a silent action.
3. Report results per job to Telegram per the "Communication" section: submitted / needs manual
   review / needs an answer (with the question) / rate-limited, with job title + company for
   each.

Do not call the `apply` tools directly yourself for this flow if a dedicated subagent exists for
the stage — otherwise call them directly, since Applying is single-job-at-a-time and doesn't need
the multi-stage pipeline "Running the hunt" uses.

### Hybrid Claude fallback (Easy Apply + external ATS, opt-in)

Hardcoded Playwright selectors are the fast, free default path and run first on every step, in
both `linkedin.ts` and `external.ts`. LinkedIn's DOM is not stable the way
Greenhouse/Lever/Workday/Ashby's is, so selector rot happens there most; rather than
dead-ending at `manual_review`/`needs_answer` on every selector miss, a bounded Claude
escalation can kick in — only on failure, never on every step:
- **Control click miss** — `linkedin.ts`: Easy Apply button, or Next/Review/Submit not
  found. `external.ts`: submit button not found (required-field selectors —
  name/email/resumeUpload — are NOT covered; those platforms' field IDs are documented as far
  more stable than LinkedIn's, and finding the right field is different work than picking a
  button to click). Escalates with the real, currently-visible button/link texts on the page
  and picks one — or refuses if none plausibly match. Never invents text that isn't actually on
  the page.
- **Unanswerable screening question** (`linkedin.ts` only — external ATS forms in this
  codebase have no dynamic Q&A schema): escalates with the question text and the candidate's
  existing truthful answer topics (the fixed fields + the `custom` map), asking only whether
  the question is a *rephrasing* of one already answered. Never invents a new value — if the
  question asks for genuinely new information, it still falls through to `needs_answer` (step
  2a above).

Opt-in per file, off by default: `EASY_APPLY_HYBRID_FALLBACK=true` for `linkedin.ts`,
`EXTERNAL_APPLY_HYBRID_FALLBACK=true` for `external.ts` — these are independent toggles,
not shared.

This project has no separate Anthropic API key/billing — the user has a Claude subscription,
not API credits — so this fallback shells out to the `claude` CLI in headless print mode,
invoking one of two project-level custom slash commands rather than an ad hoc inline prompt:
`.claude/commands/easy-apply-control-fallback.md` (control-click escalation, shared by both
files) and `.claude/commands/easy-apply-answer-fallback.md` (screening-question escalation,
`linkedin.ts` only). Keeping the task, output contract, and "never invent" rules in those
files means Claude already knows the exact steps on every invocation instead of the caller
re-deriving them in a fresh prompt each time. Each call authenticates via the same Claude Code
subscription session (not a metered API key) and is a single, isolated, non-agentic invocation
— no follow-up turns, no tool use.

None of `external.ts`'s new confirmation-check/fallback behavior has been live-tested
against a real Greenhouse/Lever/Workday/Ashby posting yet — same caveat as the rest of Phase
2's untested-live gaps (see "Connecting" below for the equivalent `connect.ts` caveat).

## Connecting

LinkedIn connection requests are now sent automatically by the `sender` stage as part of every
hunt run (see "Running the hunt" step 5) — there is no per-note Telegram approval gate anymore.
This was an explicit, informed decision (not an oversight): the wrong-recipient incident that
originally motivated the approval gate was root-caused and fixed at the automated-verification
level (`connect.ts`'s `verifyRecipientName`, `verifyProfileUrl`, and 2D-proximity candidate
matching, all fail-closed) rather than relying on a human catching it after the fact. Those
automated defenses are UNCHANGED and still run on every `connect_send` call regardless of who
triggered it.

`MAX_CONNECTS_PER_DAY` is still enforced (inside `connect.ts` itself, via `checkAndIncrement`) —
`sender` reacts to a `rate_limited` result by pausing further connects and prompting Telegram
with an overrun option for that run, per "Running the hunt" step 5.

The manual on-demand `/connect` command (draft one note for one job, outside a hunt run) is
unaffected by this — it can still be used standalone if you want to hand-pick a target.

The manual on-demand `/connect` command uses the same `connect_send` call as the automatic
path above — it also sends immediately, without a separate approval step, since the approval
gate was removed project-wide (see above). "Manual" here means "you trigger it for one
hand-picked job/profile," not "requires a review step."

### `connect_send` reliability

`connect_send` verifies its final Send click actually went through (waits for the invite dialog
to dismiss) before reporting `sent` — a click that silently no-ops correctly returns `failed`
instead of a false `sent`. `connect_send`'s own selector-miss points (More button, Connect menu
item, Send button) can escalate to the bounded Claude fallback, gated by
`CONNECT_HYBRID_FALLBACK=true` (off by default).

The full autonomous execute-stage flow (queue → email → connect → apply → cap-overrun Telegram
prompt) has not been live-tested end-to-end yet — each underlying tool (`gmail.send_email`,
`connect.connect_send`, `apply.*`) is independently already live-verified from earlier work, but
the new queue-draining orchestration in `sender.md` itself has not. Watch the first real hunt run
after this lands closely.

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
2. Never exceed `SEND_LIMIT_PER_RUN` — enforced as a daily counter (`db.check_and_increment`), so
   it can already be partially consumed by an earlier run today. Items beyond the cap stay
   `queued` in `outreach_queue` (see "Running the hunt" step 5) rather than being sent, and
   `sender` prompts Telegram with an option to raise it for the current run.
3. The "Running the hunt" pipeline sends both cold email and LinkedIn connection requests
   automatically as part of every run, per the "Connecting" section below — this is an
   explicit, informed design decision, not an oversight. Do not attempt any OTHER outreach
   channel (e.g. LinkedIn direct messages) as part of that flow.
4. If any tool call fails or returns an error, do not retry silently more than once; log the
   failure and continue with the next job rather than aborting the whole run.
5. `connect_send` is called automatically by the `sender` stage as part of every hunt run — no
   per-note human approval is required (see "Connecting"). The automated recipient-verification
   safety net inside `connect.ts` (`verifyRecipientName`, `verifyProfileUrl`, fail-closed) still
   runs on every call regardless of who/what triggered it.
6. Never use the burner account's session for `connect`/`find_linkedin_profile`, and never use
   the main account's session for `apply.linkedin`.
7. Respect `MAX_APPLIES_PER_DAY` / `MAX_CONNECTS_PER_DAY` — stop and report "limit reached" rather
   than erroring or retrying.
