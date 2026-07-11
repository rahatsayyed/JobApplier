import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { chromium } from 'playwright';
import BetterSqlite3 from 'better-sqlite3';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, saveConnection } from '../db.js';
import { checkAndIncrement } from '../lib/rateLimit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

// Main-account-only session state. This MCP must NEVER load
// `secrets/linkedin-burner-state.json` (that account is reserved for the
// `linkedin-apply` MCP in Task 3, a completely different account, never to be touched
// here). The path is intentionally hardcoded, not a configurable parameter — mirrors how
// `src/mcp/linkedin-apply.ts` hardcoded its burner path, for the same reviewability reason.
const MAIN_STATE_PATH = path.join(projectRoot, 'secrets', 'linkedin-main-state.json');

const DEFAULT_MAX_LINKEDIN_SEARCHES_PER_DAY = 20;
const DEFAULT_MAX_CONNECTS_PER_DAY = 10;

/** LinkedIn's hard cap on connection-request note length. */
export const MAX_NOTE_LENGTH = 300;

const db = openDb('data.sqlite');

export interface ProfileCandidate {
  profile_url: string;
  name: string;
  headline: string;
}

export interface FindLinkedinProfileResult {
  status: 'ok' | 'rate_limited' | 'failed';
  candidates: ProfileCandidate[];
  reason?: string;
}

export interface ConnectSendResult {
  status: 'sent' | 'rate_limited' | 'failed';
  reason?: string;
}

export interface ConnectDeps {
  db?: BetterSqlite3.Database;
  maxSearchesPerDay?: number;
  maxConnectsPerDay?: number;
  /** Injectable Playwright `chromium` launcher, for testing without a real browser. */
  chromium?: { launch: typeof chromium.launch };
}

/**
 * Pure: enforce LinkedIn's 300-character connection-note cap. Returns `ok: false` for
 * empty notes too — an empty note is never a valid, ready-to-send connect note.
 */
export function validateNoteLength(note: string): { ok: boolean; length: number } {
  const length = note.length;
  return { ok: length > 0 && length <= MAX_NOTE_LENGTH, length };
}

// Best-effort LinkedIn people-search / profile DOM selectors. LinkedIn's markup changes
// and isn't publicly stable, so these are a starting point and were not confirmed against
// a live page (see Step 5 of this task's brief, deliberately deferred to a
// human-supervised live test, mirroring Task 3's same deferral for Easy Apply selectors).
const SELECTORS = {
  resultCard: '.reusable-search__result-container, li.reusable-search__result-container',
  profileLink: 'a.app-aware-link[href*="/in/"]',
  name: 'span[aria-hidden="true"]',
  headline: '.entity-result__primary-subtitle',
  connectButton: 'button[aria-label*="Connect" i]',
  addNoteButton: 'button[aria-label*="Add a note" i]',
  noteTextarea: '#custom-message, textarea[name="message"]',
  sendButton: 'button[aria-label*="Send" i], button[aria-label*="Send now" i]',
} as const;

export async function findLinkedinProfile(
  { company, role_hint }: { company: string; role_hint?: string },
  deps: ConnectDeps = {}
): Promise<FindLinkedinProfileResult> {
  const database = deps.db ?? db;
  const browserLauncher = deps.chromium ?? chromium;
  const maxPerDay =
    deps.maxSearchesPerDay ??
    Number(process.env.MAX_LINKEDIN_SEARCHES_PER_DAY ?? DEFAULT_MAX_LINKEDIN_SEARCHES_PER_DAY);

  // Gate first, before any Playwright action — mirrors linkedin-apply.ts's pattern of
  // checking-and-incrementing the daily counter before touching the browser at all.
  const allowed = checkAndIncrement(database, 'linkedin_search', maxPerDay);
  if (!allowed) {
    return {
      status: 'rate_limited',
      candidates: [],
      reason: `daily LinkedIn search limit (${maxPerDay}) reached`,
    };
  }

  if (!existsSync(MAIN_STATE_PATH)) {
    return { status: 'failed', candidates: [], reason: 'main LinkedIn session state not found' };
  }

  let browser;
  try {
    browser = await browserLauncher.launch({ headless: true });
    const context = await browser.newContext({ storageState: MAIN_STATE_PATH });
    const page = await context.newPage();

    const keywords = `${company} ${role_hint ?? 'recruiter hiring manager talent acquisition'}`;
    await page.goto(
      `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`,
      { timeout: 30000, waitUntil: 'domcontentloaded' }
    );

    const resultEls = await page.$$(SELECTORS.resultCard);
    const candidates: ProfileCandidate[] = [];
    for (const el of resultEls.slice(0, 3)) {
      const linkEl = await el.$(SELECTORS.profileLink);
      const nameEl = await el.$(SELECTORS.name);
      const headlineEl = await el.$(SELECTORS.headline);

      const profile_url = linkEl ? (await linkEl.getAttribute('href')) ?? '' : '';
      const name = nameEl ? ((await nameEl.textContent()) ?? '').trim() : '';
      const headline = headlineEl ? ((await headlineEl.textContent()) ?? '').trim() : '';

      if (profile_url) {
        candidates.push({ profile_url, name, headline });
      }
    }

    return { status: 'ok', candidates };
  } catch (err) {
    return {
      status: 'failed',
      candidates: [],
      reason: (err as Error).message ?? 'unknown error during LinkedIn profile search',
    };
  } finally {
    if (browser) await browser.close();
  }
}

export async function connectSend(
  {
    profile_url,
    note,
    job_id,
    company,
  }: { profile_url: string; note: string; job_id?: string; company?: string },
  deps: ConnectDeps = {}
): Promise<ConnectSendResult> {
  const database = deps.db ?? db;
  const browserLauncher = deps.chromium ?? chromium;
  const maxPerDay =
    deps.maxConnectsPerDay ?? Number(process.env.MAX_CONNECTS_PER_DAY ?? DEFAULT_MAX_CONNECTS_PER_DAY);

  // Gate first, before any Playwright action — same pattern as linkedin-apply.ts's
  // applyEasyApply and this file's findLinkedinProfile above.
  const allowed = checkAndIncrement(database, 'connect_send', maxPerDay);
  if (!allowed) {
    return { status: 'rate_limited', reason: `daily connect limit (${maxPerDay}) reached` };
  }

  const { ok, length } = validateNoteLength(note);
  if (!ok) {
    return {
      status: 'failed',
      reason: `note length ${length} is invalid (must be 1-300 characters; LinkedIn's 300-character cap)`,
    };
  }

  if (!existsSync(MAIN_STATE_PATH)) {
    return { status: 'failed', reason: 'main LinkedIn session state not found' };
  }

  let browser;
  try {
    browser = await browserLauncher.launch({ headless: true });
    const context = await browser.newContext({ storageState: MAIN_STATE_PATH });
    const page = await context.newPage();
    await page.goto(profile_url, { timeout: 30000, waitUntil: 'domcontentloaded' });

    const connectButton = await page.$(SELECTORS.connectButton);
    if (!connectButton) {
      return { status: 'failed', reason: 'Connect button not found on profile' };
    }
    await connectButton.click();

    const addNoteButton = await page.$(SELECTORS.addNoteButton);
    if (addNoteButton) {
      await addNoteButton.click();
      const noteInput = await page.$(SELECTORS.noteTextarea);
      if (noteInput) {
        await noteInput.fill(note);
      }
    }

    const sendButton = await page.$(SELECTORS.sendButton);
    if (!sendButton) {
      return { status: 'failed', reason: 'Send button not found on connect dialog' };
    }
    await sendButton.click();

    saveConnection(database, {
      job_id: job_id ?? null,
      company: company ?? null,
      profile_url,
      headline: null,
      note,
      status: 'sent',
      sent_at: new Date().toISOString(),
    });

    return { status: 'sent' };
  } catch (err) {
    return {
      status: 'failed',
      reason: (err as Error).message ?? 'unknown error during connect send',
    };
  } finally {
    if (browser) await browser.close();
  }
}

const server = new McpServer({ name: 'connect', version: '0.1.0' });

server.registerTool(
  'find_linkedin_profile',
  {
    description:
      'Searches LinkedIn people-search for a contact at the given company (recruiter/hiring-manager ' +
      'style roles by default, or a role_hint), using the MAIN LinkedIn account session. Returns up to ' +
      'the top 3 candidate profiles. Gated by a daily linkedin_search rate limit. Read-only — never ' +
      'sends a connection request.',
    inputSchema: {
      company: z.string(),
      role_hint: z.string().optional(),
    },
  },
  async ({ company, role_hint }) => {
    const result = await findLinkedinProfile({ company, role_hint });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
);

server.registerTool(
  'connect_send',
  {
    description:
      'Sends a LinkedIn connection request with a note, using the MAIN LinkedIn account session. ' +
      'This performs the real action immediately when called — it does NOT wait for approval itself. ' +
      'The orchestrating agent (CLAUDE.md) must only call this AFTER an explicit human "send" reply ' +
      'to a posted draft; never call this speculatively. Gated by a daily connect_send rate limit and ' +
      "LinkedIn's 300-character note cap.",
    inputSchema: {
      profile_url: z.string(),
      note: z.string(),
      job_id: z.string().optional(),
      company: z.string().optional(),
    },
  },
  async ({ profile_url, note, job_id, company }) => {
    const result = await connectSend({ profile_url, note, job_id, company });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.env.VITEST !== 'true') {
  main().catch((err) => {
    console.error('[connect] fatal error:', err);
    process.exit(1);
  });
}
