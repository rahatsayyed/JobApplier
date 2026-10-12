import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { atsCoverageSchema, enqueueOutreach, getCalibrationRows, listJobs, listQueuedOutreach, listExcludedQueuedOutreach, markExcluded, openDb, recordOutcomeChecked, sweepDeadlines, unexcludeJob, updateOutreachStatus } from '../db.js';
import { dbPath } from '../dbPath.js';
import { handleSaveMatchResults, matchResultsInputShape } from '../matchTool.js';
import { calibrate } from '../calibrate.js';
import { checkAndIncrement } from '../lib/rateLimit.js';

const db = openDb(dbPath());

const server = new McpServer({ name: 'db', version: '1.0.0' });

server.registerTool(
  'list_jobs',
  {
    description: 'List jobs from the database with optional filters. Each row includes excluded_reason (non-null = vetoed; /apply and /applyall skip it). Set exclude_vetoed to hide vetoed jobs.',
    inputSchema: {
      status: z.string().optional(),
      limit: z.number().optional().default(100),
      exclude_vetoed: z.boolean().optional().default(false),
    },
  },
  async ({ status, limit, exclude_vetoed }) => {
    const results = listJobs(db, { status, limit, excludeVetoed: exclude_vetoed });
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  }
);

server.registerTool(
  'get_job_stats',
  {
    description: 'Get summary statistics on jobs (total, matched, by source)',
    inputSchema: {},
  },
  async () => {
    const stats = {
      total: (db.prepare('SELECT COUNT(*) as count FROM jobs').get() as any).count,
      by_status: db
        .prepare('SELECT status, COUNT(*) as count FROM jobs GROUP BY status')
        .all(),
      by_source: db
        .prepare('SELECT source, COUNT(*) as count FROM jobs GROUP BY source')
        .all(),
    };
    return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
  }
);

server.registerTool(
  'list_outreach',
  {
    description: 'List sent outreach emails with optional filters',
    inputSchema: {
      status: z.string().optional(),
      limit: z.number().optional().default(100),
    },
  },
  async ({ status, limit }) => {
    let sql = 'SELECT id, job_id, contact_email, status, sent_at, created_at FROM outreach';
    const params: (string | number)[] = [];
    if (status) {
      sql += ' WHERE status = ?';
      params.push(status);
    }
    sql += ' ORDER BY sent_at DESC LIMIT ?';
    params.push(limit);
    const results = db.prepare(sql).all(...params);
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  }
);

server.registerTool(
  'get_outreach_stats',
  {
    description: 'Get summary statistics on outreach (total sent, queued, failed)',
    inputSchema: {},
  },
  async () => {
    const stats = {
      total: (db.prepare('SELECT COUNT(*) as count FROM outreach').get() as any).count,
      by_status: db
        .prepare('SELECT status, COUNT(*) as count FROM outreach GROUP BY status')
        .all(),
      by_month: db
        .prepare(
          `SELECT strftime('%Y-%m', sent_at) as month, COUNT(*) as count
           FROM outreach WHERE sent_at IS NOT NULL
           GROUP BY month ORDER BY month DESC`,
        )
        .all(),
    };
    return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
  }
);

server.registerTool(
  'list_threads',
  {
    description: 'List email/LinkedIn threads (Phase 3)',
    inputSchema: {
      channel: z.string().optional(),
      status: z.string().optional(),
      limit: z.number().optional().default(50),
    },
  },
  async ({ channel, status, limit }) => {
    let sql = 'SELECT id, channel, job_id, contact, status, created_at FROM threads';
    const params: (string | number)[] = [];
    const conditions: string[] = [];
    if (channel) {
      conditions.push('channel = ?');
      params.push(channel);
    }
    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    try {
      const results = db.prepare(sql).all(...params);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    } catch {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { error: 'threads table not available (Phase 3 feature)' },
              null,
              2,
            ),
          },
        ],
      };
    }
  }
);

server.registerTool(
  'raw_query',
  {
    description: 'Execute a raw SQL SELECT query (read-only). Use with caution.',
    inputSchema: {
      sql: z.string(),
    },
  },
  async ({ sql }) => {
    if (!/^\s*SELECT\s+/i.test(sql)) {
      return {
        content: [{ type: 'text', text: 'Error: only SELECT queries are allowed' }],
      };
    }
    try {
      const results = db.prepare(sql).all();
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `SQL Error: ${(err as Error).message}` }],
      };
    }
  }
);

server.registerTool(
  'enqueue_outreach',
  {
    description: 'Add one prepared outreach item (resume/email/connect-note/apply-plan) to the outreach_queue for the sender stage to execute later. Pure persistence — does not send anything.',
    inputSchema: {
      job_id: z.string(),
      resume_pdf_path: z.string().optional(),
      email_subject: z.string().optional(),
      email_body: z.string().optional(),
      email_to: z.string().optional(),
      connect_note: z.string().optional(),
      connect_profile_url: z.string().optional(),
      connect_category: z.enum(['recruiter', 'peer']).optional(),
      connect_company: z.string().optional(),
      apply_platform: z.enum(['linkedin', 'greenhouse', 'lever', 'workday', 'ashby', 'none']).optional(),
      apply_url: z.string().optional(),
      resume_json: z.string().optional(),
      ats_coverage: atsCoverageSchema,
      ats_gaps: z.array(z.string()).optional(),
      fact_warnings: z.array(z.string()).optional(),
      review_applied: z.number().int().min(0).optional(),
      review_rejected: z.number().int().min(0).optional(),
    },
  },
  async (params) => {
    const id = enqueueOutreach(db, {
      job_id: params.job_id,
      resume_pdf_path: params.resume_pdf_path ?? null,
      email_subject: params.email_subject ?? null,
      email_body: params.email_body ?? null,
      email_to: params.email_to ?? null,
      connect_note: params.connect_note ?? null,
      connect_profile_url: params.connect_profile_url ?? null,
      connect_category: params.connect_category ?? null,
      connect_company: params.connect_company ?? null,
      apply_platform: params.apply_platform ?? null,
      apply_url: params.apply_url ?? null,
      resume_json: params.resume_json ?? null,
      ats_coverage: params.ats_coverage ?? null,
      ats_gaps: params.ats_gaps ?? null,
      fact_warnings: params.fact_warnings ?? null,
      review_applied: params.review_applied ?? null,
      review_rejected: params.review_rejected ?? null,
    });
    return { content: [{ type: 'text', text: JSON.stringify({ id }) }] };
  }
);

server.registerTool(
  'save_match_result',
  {
    description:
      'Persist match-stage results onto the jobs table, one row at a time. Score: when score_dims is given (four integers 0-25: skills, seniority, domain, location) the model score is ignored and the score is their sum, ' +
      'then capped by an evidence ceiling from the requirement table (59 + round(41 x evidence-weighted share of critical/high/meaningful rows met; stated counts more than structural, structural more than inferred; no weighted rows => 70)); the cap can only lower the score and the cap applied is stored as score_cap_reason (null when the sum stood). A row without score_dims is accepted ONLY as an expired row (score 0, reasons "expired"); any other row without score_dims is a per-row error "missing score_dims". ' +
      'Requirements: a stated row needs a jd_quote of 12-300 chars found in the job description or archived snapshot, else it is downgraded to structural (quotes over 300 chars are truncated); inferred rows are demoted below critical/high; the table is capped at 12 rows (critical/high always kept). ' +
      'Injection defence: if the posting (description plus snapshot, raw and as text) contains a phrase aimed at an AI screener, the score is capped at 75, score_cap_reason starts with "injection-suspect", the job is listed in `injection_suspects` ({job_id, phrases}) for the run report, and any requirement whose jd_quote is such a phrase becomes inferred. ' +
      'Strengths/gaps are capped at 3. Hard stops = critical + missing rows with a VERIFIED stated quote (structural, downgraded and inferred rows never create one; no posting text => none), never location or language rows; they are returned in `hard_stops` and stored, and apply_vetoes excludes those jobs. Confidence: low for an empty table or a posting under 300 chars of text, medium if any row is inferred, else high. ' +
      'Per-row errors, reported in `errors` and never written, never failing the call: a row without a string job_id, an error row ({job_id, error}, e.g. a matcher batch overflow: re-dispatch those jobs first), a duplicate job_id (the first occurrence wins), an unknown job_id, and an invalid score or sub-score. Valid rows are still saved in the same transaction. A null deadline never erases a stored one. Returns {saved, errors, hard_stops, injection_suspects, scores}, where scores is [{job_id, score, score_cap_reason, confidence}] with the STORED (capped) values: filter on these, never on the matcher\'s own score.',
    inputSchema: matchResultsInputShape,
  },
  async (args) => handleSaveMatchResults(db, args)
);

server.registerTool(
  'mark_excluded',
  {
    description: 'Persist veto results: mark jobs as excluded (jobs.excluded_reason) so /apply and /applyall skip them. Call after gates.apply_vetoes for every excluded job. Unknown job ids are reported in `unknown`.',
    inputSchema: {
      exclusions: z.array(z.object({ job_id: z.string(), reason: z.string().min(1) })),
    },
  },
  async ({ exclusions }) => {
    return { content: [{ type: 'text', text: JSON.stringify(markExcluded(db, exclusions)) }] };
  }
);

server.registerTool(
  'unexclude',
  {
    description: 'Manual override (/include #N): clear jobs.excluded_reason for one job so /apply and the sender no longer skip it. The previous reason is recorded in job_exclusion_log and returned as `previous_reason`. Returns an error row ({ok: false, error}) for an unknown job or a job that is not excluded. The log row is a durable override: sweepDeadlines and the apply_vetoes deadline rule skip the job from then on (the hunt also only scores unseen jobs). It does NOT resume outreach rows already marked "skipped": re-enqueue them or ask.',
    inputSchema: { job_id: z.string() },
  },
  async ({ job_id }) => {
    return { content: [{ type: 'text', text: JSON.stringify(unexcludeJob(db, job_id)) }] };
  }
);

server.registerTool(
  'record_outcome',
  {
    description: 'Record a real-world outcome for a job (replied, interview, offer, hired, rejected, no_response). The latest outcome per job is used for score calibration.',
    inputSchema: {
      job_id: z.string(),
      outcome: z.enum(['replied', 'interview', 'offer', 'hired', 'rejected', 'no_response']),
      note: z.string().optional(),
    },
  },
  async ({ job_id, outcome, note }) => {
    const result = recordOutcomeChecked(db, job_id, outcome, note);
    return { content: [{ type: 'text', text: JSON.stringify({ ...result, job_id, outcome }) }] };
  }
);

server.registerTool(
  'calibration',
  {
    description: 'Report interview rate per match-score band from recorded outcomes, with a verdict on whether scores predict outcomes.',
    inputSchema: {},
  },
  async () => {
    return { content: [{ type: 'text', text: JSON.stringify(calibrate(getCalibrationRows(db)), null, 2) }] };
  }
);

server.registerTool(
  'list_queued_outreach',
  {
    description: 'List every outreach_queue row still pending (status=queued), oldest first. Used by the sender stage to get its full backlog, including anything left over from a previous run that hit a rate cap.',
    inputSchema: {},
  },
  async () => {
    const rows = listQueuedOutreach(db);
    return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
  }
);

server.registerTool(
  'list_skipped_outreach',
  {
    description: 'List queued outreach_queue rows that list_queued_outreach does NOT return because their job was excluded after the row was queued: [{id, job_id, reason}]. The sender reports these as skipped and never sends them.',
    inputSchema: {},
  },
  async () => ({ content: [{ type: 'text', text: JSON.stringify(listExcludedQueuedOutreach(db)) }] })
);

server.registerTool(
  'update_outreach_status',
  {
    description: 'Update one status field on an outreach_queue row after attempting its action (email/connect/apply), or the overall row status once all its actions are attempted ("done"), or "skipped" for a queued row whose job was excluded (so list_skipped_outreach stops repeating it).',
    inputSchema: {
      id: z.number(),
      field: z.enum(['email_status', 'connect_status', 'apply_status', 'status']),
      value: z.string(),
    },
  },
  async ({ id, field, value }) => {
    updateOutreachStatus(db, id, field, value);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
  }
);

server.registerTool(
  'check_and_increment',
  {
    description: 'Atomically check whether a daily counter is still under its limit and increment it if so. Returns {allowed: true} and increments, or {allowed: false} without incrementing if the limit is already reached. Use a distinct `key` per thing being capped (e.g. "send_email") — do NOT reuse "connect_send" or "easy_apply", which connect.connect_send and apply.* already increment internally themselves.',
    inputSchema: {
      key: z.string(),
      limit: z.number(),
    },
  },
  async ({ key, limit }) => {
    const allowed = checkAndIncrement(db, key, limit);
    return { content: [{ type: 'text', text: JSON.stringify({ allowed }) }] };
  }
);

server.registerTool(
  'sweep_deadlines',
  {
    description: 'Run at the start of every hunt: marks scored jobs whose ISO deadline has passed as excluded ("deadline passed: <date>", never for a job already emailed/connected/applied to) and returns {expired, closingSoon (0-7 days left), unparseable (non-ISO deadlines, never compared, each reported once)}.',
    inputSchema: {},
  },
  async () => ({ content: [{ type: 'text', text: JSON.stringify(sweepDeadlines(db)) }] })
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[db] fatal error:', err);
  process.exit(1);
});
