import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getBaseResume, renderResume } from '../resume.js';

const server = new McpServer({ name: 'resume', version: '0.1.0' });

server.registerTool(
  'get_base_resume',
  {
    description: 'Get the base resume JSON',
    inputSchema: {},
  },
  async () => {
    return {
      content: [{ type: 'text', text: JSON.stringify(getBaseResume()) }],
    };
  }
);

server.registerTool(
  'render_resume',
  {
    description: 'Render a resume JSON to a PDF and return its file path',
    inputSchema: {
      resume_json: z.record(z.string(), z.any()),
    },
  },
  async ({ resume_json }) => {
    const p = await renderResume(resume_json);
    return {
      content: [{ type: 'text', text: JSON.stringify({ pdf_path: p }) }],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[resume] fatal error:', err);
  process.exit(1);
});
