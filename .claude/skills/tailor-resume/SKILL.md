---
name: tailor-resume
description: Tailor the base resume JSON for one specific job, keeping it truthful, one page, and humanized; use whenever a resume needs to be prepared before rendering a PDF for a job application or outreach email.
---

# tailor-resume

## Purpose

Given the base resume JSON and one job (description + title), produce a tailored resume JSON
that emphasizes genuinely relevant experience for that job without inventing anything. This is
the single source of truth for resume-tailoring rules — `outreach-preparer` and any apply/hunt
flow that needs a tailored resume should invoke this skill rather than re-deriving these rules.

## Inputs

1. `job` — object with at least `{title, description}` (company/url optional but helpful for context).
2. `base_resume` — the base resume JSON (from `resume.get_base_resume`).

## Rules

1. Return the SAME JSON schema/shape as `base_resume` — same top-level keys, same nested
   structure. Do not add or remove fields.
2. Rewrite experience bullet points to start with a strong action verb ("Built", "Led",
   "Reduced", "Designed", "Automated") instead of weak openers like "Responsible for" or
   "Worked on".
3. Quantify bullets with numbers ONLY where `base_resume` already supports that number (e.g.
   team size, percentage improvement, user count). Never invent a metric that isn't already
   present in some form in the base resume.
4. Mirror the job description's exact keywords and technology names wherever the candidate
   genuinely has that skill (e.g. if the JD says "React.js" and the resume says "React", you
   may write "React.js" to match; never add a technology the candidate has never used).
5. Reorder the skills list so skills mentioned in the job description appear first, most
   relevant to least relevant.
6. NEVER fabricate: company names, job titles held, employment dates, degrees, or metrics that
   have no basis in `base_resume`. Tailoring is about emphasis and wording, not invention.
7. Adjust the `jobTitle`/headline and `summary` fields (if present in the schema) to speak
   directly to the target role, using truthful language about the candidate's actual
   background — including seniority framing (e.g. don't call the candidate "Senior" if
   `base_resume`'s experience doesn't support it) and role framing (e.g. "full stack" is fine
   if the base resume genuinely shows both frontend and backend work; don't narrow to
   "backend-focused" or similar unless asked to).
8. The rendered PDF must be exactly ONE page, and that page should be genuinely full: content
   should fill at least ~85% of the page, not leave it mostly blank. If the tailored content
   runs long, trim by cutting the least-relevant bullets entirely (prefer keeping bullets with
   concrete metrics that match the job's stack over vaguer, unquantified ones) — never shrink
   font size or margins to force a fit. If trimming for the one-page rule leaves the page
   sparse, restore the next most relevant bullet(s) or skill entries rather than leaving
   whitespace — a full single page beats an over-trimmed, mostly-empty one. Never shrink font
   size or margins to fake a fill rate. After rendering via `resume.render_resume`, verify page
   count (e.g. count `/Type /Page` object occurrences in the PDF bytes) and eyeball how full the
   page is; adjust and re-render before returning if it's more than one page or clearly sparse.
9. Run the tailored `summary` and experience bullet text through the `the-humanizer` skill's
   universal rules before rendering — this is resume content, not an email/LinkedIn/Slack post,
   so only the universal phrase-level/structural rules apply, not a channel-specific set. In
   particular: never use an em dash (—) anywhere in the resume text — rewrite with a comma or
   period — and cut buzzwords like "leverage" per the humanizer's banned list.
10. If the caller supplies a genuinely new, verified fact about the candidate not present in
    `base_resume` (e.g. "I also know Redis"), it's fine to add it to the tailored resume's
    skills — but flag to the caller that the base resume itself is missing this and ask whether
    it should be added there too, so future tailoring runs don't need to be told again.

## Steps

1. Read `job.description` and `job.title`, and extract the relevant keywords/stack/seniority
   signal the same way `match-jobs` does.
2. Tailor `base_resume` following the Rules above.
3. Call `resume.render_resume({resume_json: <tailored resume>})` → `{pdf_path}`.
4. Verify the PDF is one page (Rule 8); trim and re-render if not.
5. Return `{resume_json: <tailored resume>, pdf_path: <path>}`.

## Output format

Output ONLY the following STRICT JSON object, with no extra text before or after it, no
markdown code fences, and no commentary:

```
{"resume_json": {...}, "pdf_path": "<string>"}
```
