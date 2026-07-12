import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { chromium, type Page } from 'playwright';
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

// Explicit viewport for every Playwright browser context this MCP creates. Without this,
// Playwright defaults to a 1280×720 context. A separate standalone Playwright script used to
// live-verify this file's selectors (people-search resultCard/profileLink/name/headline,
// profile-header moreButton/connectMenuItem, and the "Add a note?" dialog's
// addNoteButton/noteTextarea/sendButton — see the SELECTORS comments above and
// .superpowers/sdd/task-6-connect-fix-report.md) explicitly set `{ width: 1440, height: 2400
// }` on `newContext()`, while this file's `newContext()` calls passed no viewport at all,
// silently falling back to the 1280×720 default. That mismatch is the prime suspect for the
// live-reported "Send button not found on connect dialog" failure: the tall 2400px viewport
// used during verification means the "Add a note?" dialog's Send button was already within
// the initial layout viewport, whereas the much-shorter default 720px viewport can put that
// same button below the fold. Note that `Locator.count()` (used throughout this file's
// `.count() === 0` checks) does NOT depend on visibility or scroll position — it counts DOM
// matches regardless — so this fix does not change the semantics of any `.count()` check;
// it targets a different mechanism, whatever LinkedIn's dialog does differently at a smaller
// viewport (e.g. deferring/never mounting certain content until it would be scrolled into
// view, or a responsive layout change), consistent with the click() failing downstream of a
// `.count() > 0` check passing. This exact viewport was the one already live-verified to work
// end-to-end (short of the final "Send" click) in this session's prior investigations, so it
// is reused here for consistency rather than an untested new size — including for
// `findLinkedinProfile`, whose people-search scraping selectors were also only ever
// live-verified at this same larger viewport, never at the default.
export const BROWSER_VIEWPORT = { width: 1440, height: 2400 };

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

export interface RecordConnectionStatusResult {
  status: 'ok' | 'failed';
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

// LinkedIn people-search / profile DOM selectors.
//
// resultCard/profileLink/name/headline were LIVE-VERIFIED (see
// .superpowers/sdd/task-6-connect-fix-report.md) against a real people-search results page
// (`https://www.linkedin.com/search/results/people/?keywords=...`, main-account session) —
// the old `.reusable-search__result-container` class selector matched ZERO of the page's
// 10 real result cards. LinkedIn now renders each result as a `<div role="listitem">`
// inside a `<div role="list">`, with fully obfuscated/hashed CSS classes elsewhere — the
// ARIA roles are the stable anchor, same pattern as the `<footer>` tag found for Easy
// Apply's buttons. `a.app-aware-link[href*="/in/"]` (the old profileLink selector) also
// matched ZERO elements live; the generic `a[href*="/in/"]` does match.
//
// Within one result card there are (per live inspection) TWO `a[href*="/in/"]` links
// pointing at the same profile: an outer wrapper link whose `textContent` concatenates
// the name plus connection-degree badge plus headline plus location plus mutual-connection
// names (an accessibility/click-target artifact), and a second, inner link whose
// `textContent` is just the clean visible name. `.nth(1)` of that locator was confirmed
// clean across all 10 live results. The headline has no dedicated stable selector either;
// it was confirmed to always be the `<span>` immediately following the LAST `<span>` whose
// text matches the connection-degree bullet (`• 1st`/`• 2nd`/`• 3rd+`) — that degree badge
// itself renders as two adjacent duplicate spans (visible + accessibility mirror), so we
// take the span after the *last* match, not the first.
//
// moreButton/connectMenuItem are LIVE-VERIFIED (see
// .superpowers/sdd/task-6-connect-fix-report.md) against a real profile
// (`https://www.linkedin.com/in/snehalaundhkar/`, main-account session, read-only
// inspection): this profile shows only "Follow" + "More" as top-level actions — there is
// NO direct "Connect" button anywhere in the top-level DOM. The old bare `connectButton`
// selector (`button[aria-label^="Invite" i], button:has-text("Connect")`) was flatly wrong
// for this common case: it happened to match unrelated "Invite X to connect" buttons
// rendered inside "People you may know" carousel cards elsewhere on the page (confirmed
// live — those cards' aria-labels are literally "Invite <name> to connect"), never the
// actual action for the profile being viewed.
//
// The real flow: click the profile-header "More" button (opens a dropdown/overflow menu),
// then click "Connect" as a menu item inside that menu.
//
// `main button:has-text("More")` matched 15 elements live on the tested profile — most are
// small "…more" show-more-text toggles inside post captions (bounding-box height ~17.5px),
// NOT the profile action button; there is also a decoy `button[aria-label="More"]`
// (icon-only, exact aria-label match) with a genuine 0×0 bounding box in both headless and
// headed mode — confirmed NOT usable, so aria-label was deliberately not used as the
// selector here. The correct profile-header "More" button was the ONLY match with a
// button-shaped bounding box (confirmed live: 58.4px × 48px) — `pickButtonShapedIndex`
// below picks the first match with height >= 40px, which isolated exactly one element live.
//
// Once that "More" button is clicked, the opened menu (a `div[role="menu"]`) contained,
// live: "Send profile in a message", "Save to PDF", "Connect", "Report / Block", "About
// this member" — each item an `<a role="menuitem">` (or, for items with no href, a
// `<div role="menuitem">`). The "Connect" item was confirmed live to be
// `<a role="menuitem" href="/preload/custom-invite/?vanityName=...">Connect</a>`.
// Scoping to `[role="menu"] ... [role="menuitem"]` is what excludes the unrelated PYMK-card
// "Invite X to connect" buttons (those live entirely outside any `[role="menu"]`).
//
// addNoteButton/noteTextarea/sendButton — NOW LIVE-VERIFIED (see
// .superpowers/sdd/task-6-connect-fix-report.md, "Fix: sendButton selector + add-note
// transition wait" section) via a read-only re-inspection of the real "Add a note?" dialog
// (main-account session), stopping before any actual send.
//
// Before clicking "Add a note": the dialog shows two buttons, "Add a note"
// (`aria-label="Add a note"`) and "Send without a note" (`aria-label="Send without a
// note"`); no textarea is present yet.
//
// After clicking "Add a note": a `<textarea id="custom-message" name="message">` appears
// (confirmed to match the existing `noteTextarea` selector unchanged, no fix needed there),
// and the button set changes to "Write with AI", "Cancel" (`aria-label="Cancel adding a
// note"`), and a "Send" button whose VISIBLE TEXT is literally "Send" but whose
// `aria-label` is "Send invitation". This is the root cause of the reported "Send button
// not found on connect dialog" bug: the old `sendButton` selector's
// `button:has-text("Send invitation")` alternative matches on visible text content, and
// this button's visible text is just "Send" — "Send invitation" is only its aria-label —
// so that alternative could never match. It has been removed. The remaining
// `button[aria-label^="Send " i]` alternative already matches "Send invitation" correctly
// (confirmed live), so it is kept, and a redundant exact-match alternative is added for
// extra resilience against future copy drift. `button:has-text("Send now")` is kept as a
// last-resort text fallback in case LinkedIn shows different copy elsewhere.
export const SELECTORS = {
  resultCard: 'div[role="listitem"]',
  profileLink: 'a[href*="/in/"]',
  moreButton: 'main button:has-text("More")',
  connectMenuItem: '[role="menu"] [role="menuitem"]:has-text("Connect")',
  addNoteButton: 'button[aria-label*="add a note" i], button:has-text("Add a note")',
  noteTextarea: '#custom-message, textarea[name="message"]',
  sendButton:
    'button[aria-label="Send invitation" i], button[aria-label^="Send " i], button:has-text("Send now")',
} as const;

// How long to wait for the profile-header "More" overflow menu to actually render after
// being clicked, before checking for its "Connect" menu item. Bounded and non-throwing —
// same rationale and pattern as `waitForFormControls` in src/mcp/linkedin-apply.ts:
// `Locator.click()` only auto-waits for the clicked element ("More") itself to be
// actionable, not for whatever the click triggers afterward (the menu animating in), and
// `Locator.count()` is a synchronous snapshot with no retry — so without this wait, the
// very next `.count()` check on `connectMenuItem` races the menu's render and can
// incorrectly see 0 elements that would appear a moment later, reporting "Connect menu
// item not found" prematurely. If the menu doesn't render within the timeout, we swallow
// the error and fall through to the existing `.count()` check below, which then correctly
// resolves to the existing "Connect menu item not found" failure — never throws.
const MENU_RENDER_TIMEOUT_MS = 8000;

async function waitForConnectMenu(page: Pick<Page, 'locator'>): Promise<void> {
  await page
    .locator(SELECTORS.connectMenuItem)
    .first()
    .waitFor({ state: 'visible', timeout: MENU_RENDER_TIMEOUT_MS })
    .catch(() => {
      // Timed out waiting for the More menu to render. Don't throw — let the caller's
      // existing `.count()` check run and take the normal "not found" failure path.
    });
}

// How long to wait for the "Add a note?" dialog's post-click transition to actually render
// after clicking "Add a note" — the note `<textarea>` appearing and the button set
// switching from "Add a note"/"Send without a note" to "Write with AI"/"Cancel"/"Send" —
// before checking for the note textarea and/or the send button. Same rationale and pattern
// as `waitForConnectMenu` above and `waitForFormControls` in src/mcp/linkedin-apply.ts:
// `Locator.click()` only auto-waits for the clicked element ("Add a note") itself to be
// actionable, not for whatever the click triggers afterward (the dialog re-rendering its
// textarea and button set), and `Locator.count()` is a synchronous snapshot with no retry —
// so without this wait, the very next `.count()` checks on `noteTextarea`/`sendButton` race
// the transition and can incorrectly see 0 elements that would appear a moment later,
// reporting "Send button not found on connect dialog" prematurely (this was confirmed live
// to be a real contributing factor to that bug, alongside the `sendButton` selector fix
// above). If the transition doesn't render within the timeout, we swallow the error and
// fall through to the existing `.count()` checks below, which then correctly resolve to the
// existing failure paths — never throws.
const NOTE_TRANSITION_TIMEOUT_MS = 8000;

async function waitForNoteDialogTransition(page: Pick<Page, 'locator'>): Promise<void> {
  const anySelector = [SELECTORS.noteTextarea, SELECTORS.sendButton].join(', ');
  await page
    .locator(anySelector)
    .first()
    .waitFor({ state: 'visible', timeout: NOTE_TRANSITION_TIMEOUT_MS })
    .catch(() => {
      // Timed out waiting for the note textarea / new button set to render. Don't throw —
      // let the caller's existing `.count()` checks run and take the normal "not found"
      // failure paths.
    });
}

/**
 * Pure: given the bounding-box heights of every `SELECTORS.moreButton` match on a profile
 * page, picks the index of the first one that is button-shaped (height >= minHeightPx) —
 * this is the profile-header "More" action, as opposed to the many small "…more"
 * show-more-text toggles inside post captions (~17.5px tall, live-confirmed). Returns -1 if
 * no candidate is button-shaped. Exported for unit testing without a live Playwright page.
 */
export function pickButtonShapedIndex(boxes: Array<{ height: number }>, minHeightPx = 40): number {
  return boxes.findIndex((box) => box.height >= minHeightPx);
}

/**
 * Pure: extracts the clean visible name/headline text from a result card's collected
 * profile-link texts and span texts, per the live-verified DOM pattern documented above.
 * Exported for unit testing without a live Playwright page.
 */
export function extractNameAndHeadline(
  profileLinkTexts: string[],
  spanTexts: string[]
): { name: string; headline: string } {
  const name = (profileLinkTexts[1] ?? profileLinkTexts[0] ?? '').trim();

  let lastDegreeIdx = -1;
  spanTexts.forEach((text, idx) => {
    if (/^•\s*(1st|2nd|3rd)/.test(text.trim())) lastDegreeIdx = idx;
  });
  const headline =
    lastDegreeIdx !== -1 && lastDegreeIdx + 1 < spanTexts.length
      ? spanTexts[lastDegreeIdx + 1].trim()
      : '';

  return { name, headline };
}

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
    const context = await browser.newContext({
      storageState: MAIN_STATE_PATH,
      viewport: BROWSER_VIEWPORT,
    });
    const page = await context.newPage();

    const keywords = `${company} ${role_hint ?? 'recruiter hiring manager talent acquisition'}`;
    await page.goto(
      `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`,
      { timeout: 30000, waitUntil: 'domcontentloaded' }
    );

    // Locators (not ElementHandles) throughout: a Locator re-resolves its selector at the
    // moment of each action/read, so it survives LinkedIn's dynamic re-renders. An
    // ElementHandle instead pins to one DOM node captured at query time, which can detach
    // before a later read/click fires — see linkedin-apply.ts's identical fix.
    const resultCardsLocator = page.locator(SELECTORS.resultCard);
    const cardCount = await resultCardsLocator.count();
    const candidates: ProfileCandidate[] = [];

    for (let i = 0; i < Math.min(cardCount, 3); i++) {
      const card = resultCardsLocator.nth(i);
      const profileLinksLocator = card.locator(SELECTORS.profileLink);
      const linkCount = await profileLinksLocator.count();

      // Only indices 0 and 1 are ever consumed by extractNameAndHeadline() below — a card
      // can have MORE than 2 `a[href*="/in/"]` matches (2, 3, or 4 observed live), the
      // extras being "mutual connections"/"also viewed" avatar links unrelated to this
      // result's own profile. Querying those extra indices is not just unused work — it
      // was observed to hang/timeout live (likely lazily-rendered/off-screen nodes), so we
      // bound the loop to the indices actually used instead of the full linkCount.
      const profileLinkTexts: string[] = [];
      for (let j = 0; j < Math.min(linkCount, 2); j++) {
        profileLinkTexts.push(((await profileLinksLocator.nth(j).textContent()) ?? '').trim());
      }
      // The clean-name link is the SECOND `a[href*="/in/"]` match within a card (live
      // finding above); fall back to the first if only one link is present.
      const nameLinkIndex = linkCount > 1 ? 1 : 0;
      const profile_url =
        linkCount > 0 ? ((await profileLinksLocator.nth(nameLinkIndex).getAttribute('href')) ?? '') : '';

      const spanTexts = await card
        .locator('span')
        .evaluateAll((els) => els.map((el) => (el.textContent ?? '').trim()).filter(Boolean));

      const { name, headline } = extractNameAndHeadline(profileLinkTexts, spanTexts);

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

  // Cheap, pure, non-browser pre-flight checks run BEFORE the rate-limit gate below, so a
  // pre-flight rejection (invalid note length, missing main session) never burns a quota
  // slot for a no-op that was never going to touch Playwright.
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

  // Gate immediately before the Playwright launch — still strictly "before any Playwright
  // action" (same pattern as linkedin-apply.ts's applyEasyApply and this file's
  // findLinkedinProfile above), just moved as late as possible so the cheap checks above
  // get first refusal.
  const allowed = checkAndIncrement(database, 'connect_send', maxPerDay);
  if (!allowed) {
    return { status: 'rate_limited', reason: `daily connect limit (${maxPerDay}) reached` };
  }

  let browser;
  try {
    browser = await browserLauncher.launch({ headless: true });
    const context = await browser.newContext({
      storageState: MAIN_STATE_PATH,
      viewport: BROWSER_VIEWPORT,
    });
    const page = await context.newPage();
    await page.goto(profile_url, { timeout: 30000, waitUntil: 'domcontentloaded' });

    // Locator API throughout (see findLinkedinProfile above for the same rationale).
    //
    // Step 1: find and click the profile-header "More" button. `SELECTORS.moreButton`
    // matches multiple elements on a real profile (post "…more" toggles etc.) — filter to
    // the button-shaped one via bounding-box heights (see pickButtonShapedIndex above).
    const moreButtonsLocator = page.locator(SELECTORS.moreButton);
    if ((await moreButtonsLocator.count()) === 0) {
      return { status: 'failed', reason: 'More button not found on profile' };
    }
    const moreButtonBoxes = await moreButtonsLocator.evaluateAll((els) =>
      els.map((el) => ({ height: el.getBoundingClientRect().height }))
    );
    const moreButtonIndex = pickButtonShapedIndex(moreButtonBoxes);
    if (moreButtonIndex === -1) {
      return { status: 'failed', reason: 'no button-shaped More button found on profile' };
    }
    await moreButtonsLocator.nth(moreButtonIndex).click();
    await waitForConnectMenu(page);

    // Step 2: the "More" click opens a dropdown/overflow menu; find and click its
    // "Connect" menu item (scoped to `[role="menu"]` so this never matches the unrelated
    // "Invite X to connect" buttons rendered in "People you may know" carousel cards
    // elsewhere on the page).
    const connectMenuItemLocator = page.locator(SELECTORS.connectMenuItem);
    if ((await connectMenuItemLocator.count()) === 0) {
      return { status: 'failed', reason: 'Connect menu item not found after opening More menu' };
    }
    await connectMenuItemLocator.first().click();

    const addNoteButtonLocator = page.locator(SELECTORS.addNoteButton);
    if ((await addNoteButtonLocator.count()) > 0) {
      await addNoteButtonLocator.first().click();
      await waitForNoteDialogTransition(page);
      const noteInputLocator = page.locator(SELECTORS.noteTextarea);
      if ((await noteInputLocator.count()) > 0) {
        await noteInputLocator.first().fill(note);
      }
    }

    const sendButtonLocator = page.locator(SELECTORS.sendButton);
    if ((await sendButtonLocator.count()) === 0) {
      return { status: 'failed', reason: 'Send button not found on connect dialog' };
    }
    await sendButtonLocator.first().click();

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

/**
 * Pure bookkeeping write for a connection draft that was never sent — records a
 * `drafted` or `skipped` row so the orchestrator (per CLAUDE.md's "Connecting" section)
 * has a real tool to call when the user doesn't approve a drafted note, instead of a
 * DB write instruction with no corresponding tool. No Playwright involved and no
 * rate-limit gating needed — this never touches LinkedIn, it only records a status the
 * orchestrator already decided on.
 */
export function recordConnectionStatus(
  {
    profile_url,
    note,
    status,
    job_id,
    company,
  }: { profile_url: string; note: string; status: 'drafted' | 'skipped'; job_id?: string; company?: string },
  deps: { db?: BetterSqlite3.Database } = {}
): RecordConnectionStatusResult {
  const database = deps.db ?? db;
  try {
    saveConnection(database, {
      job_id: job_id ?? null,
      company: company ?? null,
      profile_url,
      headline: null,
      note,
      status,
      sent_at: null,
    });
    return { status: 'ok' };
  } catch (err) {
    return {
      status: 'failed',
      reason: (err as Error).message ?? 'unknown error recording connection status',
    };
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

server.registerTool(
  'record_connection_status',
  {
    description:
      "Records a connection draft's status as 'drafted' or 'skipped' in the database. Pure " +
      "bookkeeping write — no Playwright, no rate-limit gating. Use this after posting a drafted " +
      "connection note to Telegram (status='drafted'), or when the user declines to approve it " +
      "(status='skipped'), so the DB reflects what actually happened without ever calling connect_send.",
    inputSchema: {
      profile_url: z.string(),
      note: z.string(),
      status: z.enum(['drafted', 'skipped']),
      job_id: z.string().optional(),
      company: z.string().optional(),
    },
  },
  async ({ profile_url, note, status, job_id, company }) => {
    const result = recordConnectionStatus({ profile_url, note, status, job_id, company });
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
