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
The style/content rules below fold in `ResumeGuide.md` (repo root) — that file is the longer
reference; this skill is the operative checklist.

## Inputs

1. `job` — object with at least `{title, description}` (company/url optional but helpful for context).
2. `base_resume` — the base resume JSON (from `resume.get_base_resume`).

## Rules

1. Return the SAME JSON schema/shape as `base_resume` — same top-level keys, same nested
   structure. Do not add or remove fields.
2. Rewrite experience bullet points to start with a strong action verb ("Built", "Led",
   "Reduced", "Designed", "Automated") instead of a weak, responsibility-oriented opener
   ("Responsible for", "Duties included", "Worked on", "Assisted with", "Helped to"). No two
   bullets on the tailored resume should start with the same verb more than twice.
   - No personal pronouns ("I", "my", "we", "our") — omit the subject entirely.
   - No passive voice — the candidate performs the action ("Improved X", not "X was improved").
   - No filler words ("various", "several", "in order to") — use the specific number or name
     the specific thing instead.
   - Each bullet stays 10-30 words and reads on at most 2 visual lines.
3. Quantify bullets with numbers ONLY where `base_resume` already supports that number (e.g.
   team size, percentage improvement, user count). Never invent a metric that isn't already
   present in some form in the base resume. Aim for at least 75% of experience bullets carrying
   a real, traceable number — this is a target to work toward within the "never invent" rule,
   not a license to fabricate one to hit the ratio.
4. Mirror the job description's exact keywords and technology names wherever the candidate
   genuinely has that skill (e.g. if the JD says "React.js" and the resume says "React", you
   may write "React.js" to match; never add a technology the candidate has never used).
   This mirroring applies to bullet text and `summary` only. Skill item strings and every
   numeral are kept verbatim from the base resume, and NEW skills may not be added to
   `skills[]` (the render step now rejects unsupported claims).
5. Reorder the skills list so skills mentioned in the job description appear first, most
   relevant to least relevant. Reorder only: do not rename, rewrite or add skill items.
6. Job fit: for each experience bullet, apply the litmus test — "would this matter to someone
   hiring for this specific role/JD?" Yes → keep. Partially → rewrite to foreground the
   JD-relevant angle (same underlying fact, different emphasis — never a new fact). No → cut it
   entirely rather than keep it as filler; a shorter, more relevant resume beats a longer,
   padded one. Target 90%+ of surviving content being genuinely relevant to this JD.
7. NEVER fabricate: company names, job titles held, employment dates, degrees, or metrics that
   have no basis in `base_resume`. Tailoring is about emphasis and wording, not invention.
8. Adjust the `jobTitle`/headline and `summary` fields (if present in the schema) to speak
   directly to the target role, using truthful language about the candidate's actual
   background — including seniority framing (e.g. don't call the candidate "Senior" if
   `base_resume`'s experience doesn't support it) and role framing (e.g. "full stack" is fine
   if the base resume genuinely shows both frontend and backend work; don't narrow to
   "backend-focused" or similar unless asked to).
9. The rendered PDF must be exactly ONE page, and that page should be genuinely full: content
   should fill at least ~85% of the page, not leave it mostly blank. If the tailored content
   runs long, trim by cutting the least-relevant bullets entirely (prefer keeping bullets with
   concrete metrics that match the job's stack over vaguer, unquantified ones) — never shrink
   font size or margins to force a fit. If trimming for the one-page rule leaves the page
   sparse, restore the next most relevant bullet(s) or skill entries rather than leaving
   whitespace — a full single page beats an over-trimmed, mostly-empty one. Never shrink font
   size or margins to fake a fill rate. After rendering via `resume.render_resume`, verify page
   count (e.g. count `/Type /Page` object occurrences in the PDF bytes) and eyeball how full the
   page is; adjust and re-render before returning if it's more than one page or clearly sparse.
10. Run the tailored `summary` and experience bullet text through the `the-humanizer` skill's
    universal rules before rendering — this is resume content, not an email/LinkedIn/Slack post,
    so only the universal phrase-level/structural rules apply, not a channel-specific set. In
    particular: never use an em dash (—) anywhere in the resume text — rewrite with a comma or
    period — and cut buzzwords like "leverage", "team player", "results-driven",
    "detail-oriented" per the humanizer's banned list and `ResumeGuide.md`'s anti-pattern table.
11. Bullet punctuation must be consistent across the whole tailored resume: either every bullet
    ends with a period, or none do — never a mix.
12. If the caller supplies a genuinely new, verified fact about the candidate not present in
    `base_resume` (e.g. "I also know Redis"), the user must first add it to the base resume
    file. Until then it must NOT appear in the tailored JSON (the render step rejects
    unsupported claims); only flag it in your report to the caller as missing from the base
    resume.

## Steps

1. Read `job.description` and `job.title`, and extract the relevant keywords/stack/seniority
   signal the same way `match-jobs` does.
2. Tailor `base_resume` following the Rules above.
3. Call `resume.render_resume({resume_json: <tailored resume>})` → `{pdf_path}`.
4. Verify the PDF is one page (Rule 9); trim and re-render if not.
5. Return `{resume_json: <tailored resume>, pdf_path: <path>}`.

## Output format

Output ONLY the following STRICT JSON object, with no extra text before or after it, no
markdown code fences, and no commentary:

```
{"resume_json": {...}, "pdf_path": "<string>"}
```
