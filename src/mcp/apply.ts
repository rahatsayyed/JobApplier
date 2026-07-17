import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { applyEasyApply } from '../apply/linkedin.js';
import { applyExternal } from '../apply/external.js';

// One MCP server, one tool per apply platform. src/apply/linkedin.ts and src/apply/external.ts
// keep their own Playwright flows and unit tests (applyEasyApply / applyExternal), unchanged —
// this file only owns the MCP tool surface, since both flows already share the same daily
// MAX_APPLIES_PER_DAY counter and the same "Applying" orchestration in CLAUDE.md.
const server = new McpServer({ name: 'apply', version: '0.1.0' });

server.registerTool(
  'linkedin',
  {
    description:
      'Applies to a LinkedIn job posting via Easy Apply using the burner account session. ' +
      'Gated by a daily MAX_APPLIES_PER_DAY limit. Falls back to manual_review if the burner ' +
      'session is missing, the posting has no Easy Apply button, or a screening question cannot ' +
      'be answered from config/easy-apply-answers.json.',
    inputSchema: {
      job_id: z.string(),
    },
  },
  async ({ job_id }) => {
    const result = await applyEasyApply({ job_id });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
);

function registerExternalPlatform(platform: string) {
  server.registerTool(
    platform,
    {
      description:
        `Apply directly to a ${platform}-hosted job posting using its apply_url, filling in the ` +
        'tailored resume and cover letter prepared for that job. Refuses with manual_review if ' +
        `apply_url does not actually resolve to ${platform} (selector drift/redirect). Gated by ` +
        'the same daily MAX_APPLIES_PER_DAY limit shared with the linkedin tool. Falls back to ' +
        'manual_review if a required field cannot be located, the submit control cannot be ' +
        'found, or the submission cannot be confirmed after clicking submit.',
      inputSchema: {
        job_id: z.string(),
      },
    },
    async ({ job_id }) => {
      const result = await applyExternal({ job_id, expected_platform: platform });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );
}

for (const platform of ['greenhouse', 'lever', 'workday', 'ashby']) {
  registerExternalPlatform(platform);
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.env.VITEST !== 'true') {
  main().catch((err) => {
    console.error('[apply] fatal error:', err);
    process.exit(1);
  });
}
