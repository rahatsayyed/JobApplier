import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openDb } from '../db.js';

const db = openDb('data.sqlite');

const server = new McpServer({ name: 'sqlite', version: '1.0.0' });

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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[sqlite] fatal error:', err);
  process.exit(1);
});
