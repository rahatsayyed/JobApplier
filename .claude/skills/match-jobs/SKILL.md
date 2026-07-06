---
name: match-jobs
description: Score how well a single job posting matches the candidate's base resume; use whenever a job needs a fit score before deciding to pursue it.
---

# match-jobs

## Purpose

Given ONE Job object and the base resume JSON, decide how good a fit this job is. Output a single honest score. Do not inflate scores to be nice — a bad match should get a low score.

## Inputs

1. `job` — object with fields `{id, source, title, company, url, apply_url, description}`.
2. `resume` — the base resume JSON (from `resume.get_base_resume`), containing skills, experience, titles, summary, location/preferences.

## Steps

1. Read `job.description` and `job.title` fully. Extract:
   - Required/preferred skills and stack (languages, frameworks, tools).
   - Seniority level implied (junior/mid/senior/lead), from years-of-experience mentions or title wording.
   - Domain/industry (e.g. fintech, healthcare, e-commerce) if stated.
   - Location requirement (remote / onsite / specific city or country) and any timezone constraint.
2. Read the resume JSON. Extract the candidate's skills list, most recent job titles, years of experience (compute from work history dates if not explicit), and any stated location/remote preference.
3. Score FOUR sub-areas, each 0-25 points, then sum for a 0-100 total:
   - **Skills/stack overlap (0-25)**: What fraction of the job's required/preferred skills appear in the resume's skills or experience bullets? 25 = nearly all required skills present; 0 = little to no overlap.
   - **Seniority fit (0-25)**: Does the candidate's years of experience and title level match what the job expects? 25 = clear match; 12 = one level off; 0 = two+ levels off (e.g. resume is junior, job wants staff/lead, or vice versa).
   - **Domain relevance (0-25)**: Has the candidate worked in the same or an adjacent domain/industry? 25 = same domain; 12 = adjacent/transferable; 0 = unrelated and job explicitly requires domain expertise.
   - **Location/remote fit (0-25)**: Does the job's location requirement match the candidate's stated location/remote preference? 25 = fully compatible (remote job, or same country/city, or remote-friendly for candidate's location); 0 = incompatible (onsite-only in a country/city the candidate is not in and cannot relocate to).
4. Sum the four sub-scores for a `score` between 0 and 100.
5. List every required/preferred skill or keyword from the job description that is MISSING from the resume, as `missing_keywords` (an array of short strings, e.g. `"GraphQL"`, `"Kubernetes"`). If nothing is missing, use an empty array.
6. Write a short `reasons` string (1-3 sentences) explaining the score: call out which sub-areas were strong and which were weak. Be specific and honest, not generic praise.
7. Do NOT round up to make the job look more promising than it is. If in doubt about a sub-score, score it lower rather than higher.

## Output format

Output ONLY the following STRICT JSON object, with no extra text before or after it, no markdown code fences, and no commentary:

```
{"score": <integer 0-100>, "reasons": "<string>", "missing_keywords": ["<string>", ...]}
```

Rules for the output:
- `score` must be an integer between 0 and 100 inclusive.
- `reasons` must be a plain string (no nested JSON).
- `missing_keywords` must be an array of strings (can be empty `[]`).
- Do not add any keys other than `score`, `reasons`, and `missing_keywords`.
- Do not wrap the JSON in ```json fences. Output raw JSON only.
