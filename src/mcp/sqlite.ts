import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { openDb } from '../db.js';

const server = new McpServer({ name: 'sqlite', version: '1.0.0' });
const db = openDb();

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_jobs',
      description: 'List jobs from the database with optional filters',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            description: 'Filter by status (e.g., "matched", "sent")',
          },
          limit: {
            type: 'number',
            description: 'Max results to return (default 100)',
          },
        },
      },
    },
    {
      name: 'get_job_stats',
      description: 'Get summary statistics on jobs (total, matched, by source)',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'list_outreach',
      description: 'List sent outreach emails with optional filters',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            description: 'Filter by status (e.g., "sent", "failed")',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 100)',
          },
        },
      },
    },
    {
      name: 'get_outreach_stats',
      description: 'Get summary statistics on outreach (total sent, queued, failed)',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'list_threads',
      description: 'List email/LinkedIn threads (Phase 3)',
      inputSchema: {
        type: 'object',
        properties: {
          channel: {
            type: 'string',
            description: 'Filter by channel ("email" or "linkedin")',
          },
          status: {
            type: 'string',
            description: 'Filter by status (e.g., "needs_reply", "closed")',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 50)',
          },
        },
      },
    },
    {
      name: 'raw_query',
      description: 'Execute a raw SQL SELECT query (read-only). Use with caution.',
      inputSchema: {
        type: 'object',
        properties: {
          sql: {
            type: 'string',
            description: 'SQL SELECT query',
          },
        },
        required: ['sql'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    switch (request.params.name) {
      case 'list_jobs': {
        const { status, limit = 100 } = request.params.arguments as {
          status?: string;
          limit?: number;
        };
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

      case 'get_job_stats': {
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

      case 'list_outreach': {
        const { status, limit = 100 } = request.params.arguments as {
          status?: string;
          limit?: number;
        };
        let sql =
          'SELECT id, job_id, contact_email, status, sent_at, created_at FROM outreach';
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

      case 'get_outreach_stats': {
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

      case 'list_threads': {
        const { channel, status, limit = 50 } = request.params.arguments as {
          channel?: string;
          status?: string;
          limit?: number;
        };
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
          // threads table may not exist in Phase 1
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

      case 'raw_query': {
        const { sql } = request.params.arguments as { sql: string };
        // Only allow SELECT to prevent accidental mutations
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
            content: [
              { type: 'text', text: `SQL Error: ${(err as Error).message}` },
            ],
          };
        }
      }

      default:
        return { content: [{ type: 'text', text: 'Unknown tool' }] };
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
    };
  }
});

const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);
