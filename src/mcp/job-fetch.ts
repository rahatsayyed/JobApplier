import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openDb, isSeen, saveJob } from '../db.js';
import { fetchAllJobs, fetchHiringPosts } from '../sources/index.js';

const db = openDb('data.sqlite');

const server = new McpServer({ name: 'job-fetch', version: '0.1.0' });

server.registerTool(
  'search_jobs',
  {
    description: 'Search job boards (Adzuna, Remotive, RemoteOK) for a role',
    inputSchema: {
      role: z.string(),
      location: z.string().optional(),
    },
  },
  async ({ role, location }) => {
    const jobs = await fetchAllJobs({ role, location });
    return {
      content: [{ type: 'text', text: JSON.stringify(jobs) }],
    };
  }
);

server.registerTool(
  'search_hiring_posts',
  {
    description: 'Search LinkedIn hiring posts via Google dorks (Serper)',
    inputSchema: {
      role: z.string(),
      geo: z.string().optional(),
    },
  },
  async ({ role, geo }) => {
    const jobs = await fetchHiringPosts({ role, geo });
    return {
      content: [{ type: 'text', text: JSON.stringify(jobs) }],
    };
  }
);

server.registerTool(
  'list_new_jobs',
  {
    description: 'Fetch jobs from all sources and return only ones not seen before, saving them to the db',
    inputSchema: {
      role: z.string(),
      location: z.string().optional(),
    },
  },
  async ({ role, location }) => {
    const jobs = await fetchAllJobs({ role, location });
    const newJobs = jobs.filter((job) => !isSeen(db, job.id));
    for (const job of newJobs) {
      saveJob(db, job);
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(newJobs) }],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[job-fetch] fatal error:', err);
  process.exit(1);
});
