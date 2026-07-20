import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { enqueueOutreach, listQueuedOutreach, openDb, updateOutreachStatus } from '../db.js';
import { checkAndIncrement } from '../lib/rateLimit.js';

const db = openDb('data.sqlite');

const server = new McpServer({ name: 'db', version: '1.0.0' });

server.registerTool(
  'list_jobs',
  {
    description: 'List jobs from the database with optional filters',
    inputSchema: {
      status: z.string().optional(),
      limit: z.number().optional().default(100),
    },
  },
  async ({ status, limit }) => {
    let sql = 'SELECT id, source, title, company, score, status, created_at FROM jobs';
    const params: (string | number)[] = [];
    if (status) {
      sql += ' WHERE status = ?';
      params.push(status);
    }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    const results = db.prepare(sql).all(...params);
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
    });
    return { content: [{ type: 'text', text: JSON.stringify({ id }) }] };
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
  'update_outreach_status',
  {
    description: 'Update one status field on an outreach_queue row after attempting its action (email/connect/apply), or the overall row status once all its actions are attempted.',
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[db] fatal error:', err);
  process.exit(1);
});
