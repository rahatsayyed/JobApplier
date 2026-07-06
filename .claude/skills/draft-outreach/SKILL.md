---
name: draft-outreach
description: Draft, critique-and-rewrite, then humanize a cold outreach email for a specific job and contact; use whenever an outreach email needs to be produced before sending.
---

# draft-outreach

## Purpose

Produce ONE final, ready-to-send cold outreach email (subject + body) for a specific job, tailored resume, and chosen contact. This skill runs a two-pass drafter/reviewer process, then a humanizer pass, before returning output.

## Inputs

1. `job` — object with fields `{id, source, title, company, url, apply_url, description}`.
2. `tailored_resume_summary` — a short summary (a few sentences or bullets) of the resume that was tailored for this specific job: candidate's current/target title, 2-4 strongest matching skills or achievements relevant to this job.
3. `contact` — the chosen contact object, at minimum `{email, type, verified, source, confidence}`. Only proceed if `contact.verified` is true; if not verified, do not draft — report back that no verified contact exists (this should normally be filtered out before this skill is invoked).

## Step A — DRAFT

1. Write a subject line: short (under 60 characters), specific to the role and company (e.g. mentions the job title or a specific detail from the posting). No generic subjects like "Job Application" or "Following up".
2. Write the email body following these rules:
   - Total body length under 180 words.
   - Open with 1 sentence: who you are and why you're reaching out about THIS specific role at THIS specific company (reference something concrete from `job.title` or `job.description`, not a generic template line).
   - State 2-3 relevant strengths or achievements pulled directly from `tailored_resume_summary` — these must be real facts from the resume, never invented or exaggerated.
   - End with exactly ONE clear ask (e.g. "Could we set up a 15-minute call this week?" or "I've attached my resume — happy to share more detail if useful.").
   - Tone: professional, direct, warm but not effusive.
   - Do NOT use buzzwords or filler phrases such as "passionate about", "team player", "results-driven", "synergy", "leverage", "dynamic", "go-getter", "hit the ground running".
   - Do NOT fabricate any company names, job titles, dates, metrics, or achievements not present in `tailored_resume_summary` or the resume.
   - Do not include a formal letterhead, address block, or attachments list in the body text — the resume PDF is attached separately by the caller.
3. This produces a draft `{subject, body}`.

## Step B — REVIEWER pass

1. Critique the Step A draft against this checklist:
   - Is it generic? Could this exact email be sent to any company for any role? If yes, rewrite to add specifics from `job.description` or `job.title`.
   - Is it over 180 words? If yes, cut filler and tighten sentences.
   - Does it contain any claim, number, company name, or title not traceable to `tailored_resume_summary`? If yes, remove or correct it.
   - Does it contain buzzwords from the banned list above? If yes, replace with plain, concrete language.
   - Does it have more than one clear ask? If yes, collapse to a single ask.
   - Is the subject line generic or vague? If yes, make it specific.
2. Rewrite the draft ONCE, incorporating all fixes from the critique. This produces a revised `{subject, body}`. Do not do more than one rewrite pass.

## Step C — Humanize

1. Invoke the `the-humanizer` skill on the final `body` text from Step B (treat it as an email; let the skill auto-detect content type if needed).
2. Replace `body` with the humanizer's rewritten output.
3. Do not run the humanizer on the `subject` line.

## Output format

Output ONLY the following STRICT JSON object, with no extra text before or after it, no markdown code fences, and no commentary:

```
{"subject": "<string>", "body": "<string>"}
```

Rules for the output:
- `subject` and `body` must be plain strings.
- `body` must contain the final, humanized email text (plain text, paragraphs separated by `\n\n`, no HTML).
- Do not add any keys other than `subject` and `body`.
- Do not wrap the JSON in ```json fences. Output raw JSON only.
