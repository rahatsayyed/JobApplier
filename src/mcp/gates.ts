import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { checkLiveness } from '../liveness.js';
import { vetoResults } from '../vetoes.js';

const server = new McpServer({ name: 'gates', version: '0.1.0' });

server.registerTool(
  'check_liveness',
  {
    description: 'Check whether a job posting URL is still live: returns active, expired, or uncertain',
    inputSchema: { url: z.string().url() },
  },
  async ({ url }) => {
    const liveness = await checkLiveness(url);
    return { content: [{ type: 'text', text: JSON.stringify({ liveness }) }] };
  }
);

const verdict = z.enum(['PASS', 'FAIL', 'FLAG']);

server.registerTool(
  'apply_vetoes',
  {
    description: 'Apply veto gates (location/language FAIL, deal-breaker keywords) to match results',
    inputSchema: {
      results: z.array(
        z.object({
          job_id: z.string(),
          score: z.number(),
          location_verdict: verdict.optional(),
          language_gate: verdict.optional(),
        })
      ),
      jobs: z.array(z.object({ id: z.string(), title: z.string(), description: z.string() })),
    },
  },
  async ({ results, jobs }) => {
    return { content: [{ type: 'text', text: JSON.stringify(vetoResults(results, jobs)) }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[gates] fatal error:', err);
  process.exit(1);
});
