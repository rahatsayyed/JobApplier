import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { chromium, type Page, type Response } from 'playwright';
import BetterSqlite3 from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, saveConnection } from '../db.js';
import { checkAndIncrement } from '../lib/rateLimit.js';
import { resolveControlWithFallback, type FallbackDeps } from '../lib/domFallback.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

// Main-account session only — never the linkedin-apply burner session (see that file's
// identical hardcoded-path pattern).
const MAIN_STATE_PATH = path.join(projectRoot, 'secrets', 'linkedin-main-state.json');

const DEFAULT_MAX_LINKEDIN_SEARCHES_PER_DAY = 20;
const DEFAULT_MAX_CONNECTS_PER_DAY = 10;

// Explicit viewport (Playwright otherwise defaults to 1280x720) — this size is the one
// live-verified to work end-to-end for this file's selectors; a shorter viewport was found
// to hide the connect dialog's Send button below the fold.
export const BROWSER_VIEWPORT = { width: 1440, height: 2400 };

/** LinkedIn's hard cap on connection-request note length. */
export const MAX_NOTE_LENGTH = 300;

// Debug screenshots for connectSend(), gitignored — opt-in aid for diagnosing a suspected
// false-positive 'sent' result (see docs/phase2-known-issues.md).
const DEBUG_SCREENSHOT_DIR = path.join(projectRoot, 'debug', 'connect');

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
  /** Hybrid Claude fallback for selector-miss escalation (see domFallback.ts); off by default. */
  fallback?: FallbackDeps;
  fallbackEnabled?: boolean;
  /** Save a screenshot at each key connectSend() step to debug/connect/ (gitignored); off by default. */
  debugScreenshots?: boolean;
  /** Total time to keep polling for the "Pending" button before giving up. Injectable for tests. */
  pendingConfirmationTimeoutMs?: number;
  /** How long each individual poll attempt waits before reloading and trying again. */
  pendingConfirmationPollMs?: number;
}

async function captureDebugScreenshot(
  page: Pick<Page, 'screenshot'>,
  enabled: boolean,
  label: string
): Promise<void> {
  if (!enabled) return;
  try {
    mkdirSync(DEBUG_SCREENSHOT_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    await page.screenshot({ path: path.join(DEBUG_SCREENSHOT_DIR, `${timestamp}-${label}.png`) });
  } catch {
    // Best-effort diagnostic only — never let a screenshot failure break the real flow.
  }
}

/**
 * Escalates to a bounded Claude call over the real, currently-visible control texts
 * matching `candidateSelector`, clicking only if Claude's choice is verbatim one of them.
 * Returns whether a click happened. Use directly (not via `findAndClickControl`) when the
 * primary-path check isn't a plain `count() > 0` (e.g. the More-button bounding-box filter).
 */
async function escalateClick(
  page: Pick<Page, 'locator'>,
  intent: string,
  fallback: { enabled: boolean; deps?: FallbackDeps },
  candidateSelector = 'button, [role="button"], a[role="button"]'
): Promise<boolean> {
  const clickableLocator = page.locator(candidateSelector);
  const candidates = await clickableLocator.evaluateAll((els) =>
    els.map((el) => el.textContent?.trim()).filter((t): t is string => !!t)
  );
  const chosenText = await resolveControlWithFallback(candidates, intent, fallback.deps);
  if (!chosenText) return false;

  const fallbackLocator = clickableLocator.filter({ hasText: chosenText });
  if ((await fallbackLocator.count()) === 0) return false;
  await fallbackLocator.first().click();
  return true;
}

/**
 * Clicks the element matched by `selector`. If nothing matches and the hybrid fallback is
 * enabled, escalates via `escalateClick` over `candidateSelector`. Mirrors
 * src/apply/linkedin.ts's `findAndClickControl`.
 */
async function findAndClickControl(
  page: Pick<Page, 'locator'>,
  selector: string,
  intent: string,
  fallback: { enabled: boolean; deps?: FallbackDeps },
  candidateSelector?: string
): Promise<boolean> {
  const primaryLocator = page.locator(selector);
  if ((await primaryLocator.count()) > 0) {
    await primaryLocator.first().click();
    return true;
  }
  if (!fallback.enabled) return false;
  return escalateClick(page, intent, fallback, candidateSelector);
}

/**
 * Pure: enforce LinkedIn's 300-character connection-note cap. Returns `ok: false` for
 * empty notes too — an empty note is never a valid, ready-to-send connect note.
 */
export function validateNoteLength(note: string): { ok: boolean; length: number } {
  const length = note.length;
  return { ok: length > 0 && length <= MAX_NOTE_LENGTH, length };
}

// LinkedIn people-search / profile DOM selectors. See git history / .superpowers/sdd/task-6
// -connect-fix-report.md for the live-inspection notes behind each of these.
export const SELECTORS = {
  resultCard: 'div[role="listitem"]',
  profileLink: 'a[href*="/in/"]',
  // Filtered further by pickButtonShapedIndex (below) to isolate the real profile-header
  // "More" button from small post "…more" text toggles that also match this selector.
  moreButton: 'main button:has-text("More")',
  // Scoped to [role="menu"] so it never matches unrelated sidebar "Invite X to connect" links.
  connectMenuItem: '[role="menu"] [role="menuitem"]:has-text("Connect")',
  addNoteButton: 'button[aria-label*="add a note" i], button:has-text("Add a note")',
  noteTextarea: '#custom-message, textarea[name="message"]',
  // The Send button's accessible name ("Send invitation") lives only in its aria-label, not
  // its visible text ("Send") — hence the aria-label-based alternatives.
  sendButton:
    'button[aria-label="Send invitation" i], button[aria-label^="Send " i], button:has-text("Send now")',
  // Once a request is recorded, LinkedIn shows a "Pending" `<a>` (not a `<button>`) in place
  // of "+ Follow". Multiple matches can exist on one page (e.g. a duplicate sticky-nav copy)
  // — disambiguated by proximity to the profile's own name, see pickNearestLocator below.
  pendingButton: 'a[aria-label^="Pending" i]',
  // Some profiles show "Connect" directly at the top level instead of hiding it behind
  // "More" — an `<a>`, not a `<button>`. Can also match more than once on a real page (e.g.
  // a real profile was confirmed to render this twice — once in a sticky nav element with no
  // section ancestor, once in the actual profile card ~143px below the name) — disambiguated
  // by proximity, not a DOM-ancestor guess (two different ancestor-based guesses have each
  // failed on a different real profile). See pickNearestLocator below.
  directConnectButton: 'a[aria-label^="Invite " i][aria-label$=" to connect" i]',
  // LinkedIn doesn't consistently render the profile's own name in one heading tag (a real
  // profile was confirmed to have ZERO `<h1>` anywhere, with the name in an `<h2>` instead)
  // — search both. Used only to locate the name's position for proximity-based picks.
  nameHeadings: 'main h1, main h2',
  // The "Add a note?" / "Personalize your invitation to <Name>" dialog container, used only
  // to extract the stated recipient name for verification against the expected name.
  // `:visible` (a Playwright selector extension, not standard CSS) excludes hidden/decoy
  // dialog elements that may share this role elsewhere on the page — INCIDENT 2026-07-17
  // (#2): `.first()` on an unfiltered match is a plausible way to silently grab the wrong
  // one, the same class of bug as directConnectButton's.
  noteDialogContainer: '[role="dialog"]:visible, [role="alertdialog"]:visible',
} as const;

/**
 * Pure: extracts the profile owner's name from `page.title()` (e.g. "Tanvi Gaharwar |
 * LinkedIn" -> "Tanvi Gaharwar") — confirmed reliable where `<h1>` is not. Exported for
 * unit testing.
 */
export function extractExpectedNameFromTitle(title: string): string {
  const idx = title.indexOf(' | ');
  return (idx === -1 ? title : title.slice(0, idx)).trim();
}

export interface Point {
  x: number;
  y: number;
}

// Max plausible 2D distance (px) between the profile's own name and a real header action
// button. INCIDENT 2026-07-17 (#3): confirmed-working real header buttons sit ~130-145px
// below the name in the same X column; sidebar-suggestion-card decoys sit ~800-900px away
// (mostly in X, a different column entirely). 300px is a generous margin above the real
// case and well under the decoy distance — a candidate farther than this is rejected as
// implausible rather than accepted just for being the only/closest match available.
const MAX_PLAUSIBLE_CANDIDATE_DISTANCE_PX = 300;

/**
 * Pure: given the profile name element's position and each selector-match candidate's
 * position, picks the index of the candidate closest by full 2D (Euclidean) distance — the
 * real profile-card element, not a duplicate/decoy elsewhere on the page. Y-only distance is
 * NOT enough (INCIDENT #2: a sidebar card can share the header's Y while sitting in a
 * different X column). Returns -1 if there are no candidates, OR if the single nearest one
 * is farther than `maxDistancePx` — an implausibly distant "nearest" match (e.g. the only
 * candidate on the page is a sidebar decoy, INCIDENT #3) must be rejected, not accepted just
 * for being the closest available. Exported for unit testing.
 */
export function pickNearestToNameIndex(
  namePoint: Point,
  candidates: Point[],
  maxDistancePx: number = MAX_PLAUSIBLE_CANDIDATE_DISTANCE_PX
): number {
  if (candidates.length === 0) return -1;
  const distanceSq = (p: Point) => (p.x - namePoint.x) ** 2 + (p.y - namePoint.y) ** 2;
  let bestIndex = 0;
  let bestDistance = distanceSq(candidates[0]);
  for (let i = 1; i < candidates.length; i++) {
    const distance = distanceSq(candidates[i]);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return Math.sqrt(bestDistance) <= maxDistancePx ? bestIndex : -1;
}

/** Position of the heading whose text matches `expectedName`, or null if none found. */
async function getProfileNamePoint(page: Pick<Page, 'locator'>, expectedName: string): Promise<Point | null> {
  if (!expectedName) return null;
  const headings = await page
    .locator(SELECTORS.nameHeadings)
    .evaluateAll((els) =>
      els.map((el) => {
        const box = el.getBoundingClientRect();
        return { text: (el.textContent ?? '').trim(), x: box.x, y: box.y };
      })
    );
  const match = headings.find((h) => h.text === expectedName);
  return match ? { x: match.x, y: match.y } : null;
}

/**
 * Resolves to whichever match of `selector` sits closest (2D distance) to the profile's own
 * name, replacing a DOM-ancestor scoping guess with proximity to a known-real anchor — and to
 * a zero-match locator (via `.nth(count)`, out of range) if the nearest is implausibly far
 * (see `pickNearestToNameIndex`), so an all-decoy page correctly falls through instead of
 * clicking the only match that exists. Falls back to `.first()` when there are no matches at
 * all or no name position — preserving `Locator.waitFor`'s auto-poll behavior for an element
 * that hasn't rendered yet.
 */
async function pickNearestLocator(page: Pick<Page, 'locator'>, selector: string, namePoint: Point | null) {
  const candidatesLocator = page.locator(selector);
  const count = await candidatesLocator.count();
  if (count === 0 || namePoint === null) return candidatesLocator.first();
  const candidates = await candidatesLocator.evaluateAll((els) =>
    els.map((el) => {
      const box = el.getBoundingClientRect();
      return { x: box.x, y: box.y };
    })
  );
  const index = pickNearestToNameIndex(namePoint, candidates);
  return candidatesLocator.nth(index === -1 ? count : index);
}

/**
 * Pure: extracts the recipient name from LinkedIn's "...invitation to <Name>" dialog copy.
 * Bounded by the first sentence terminator (`.`/`?`/`!`), a newline, " by adding a note", or
 * end-of-string — NOT by end-of-string alone, since a real dialog variant (the pre-note
 * "Add a note to your invitation?" screen) has a full paragraph of trailing copy after the
 * name, which previously made this return '' and silently fail-closed on a legitimate send.
 * Exported for unit testing.
 */
export function extractDialogRecipientName(dialogText: string): string {
  const match = dialogText.match(/invitation to\s+(.+?)(?:\s+by adding a note\b|[.?!]|\n|$)/i);
  return match ? match[1].trim() : '';
}

/**
 * Pure: case-insensitive first-name comparison, tolerating LinkedIn's "first name + last
 * initial" dialog abbreviation (e.g. "Vaishali S." for "Vaishali Sharma").
 */
export function namesPlausiblyMatch(expectedName: string, recipientName: string): boolean {
  const firstWord = (s: string) => s.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const expectedFirst = firstWord(expectedName);
  const recipientFirst = firstWord(recipientName);
  if (!expectedFirst || !recipientFirst) return false;
  return (
    expectedFirst === recipientFirst ||
    expectedFirst.startsWith(recipientFirst) ||
    recipientFirst.startsWith(expectedFirst)
  );
}

/**
 * Pure: the mandatory recipient-name verification gate. FAIL-CLOSED: if either name can't be
 * extracted, this BLOCKS (does not proceed) — INCIDENT 2026-07-17 (#2) showed the previous
 * "unverifiable, so allow" leniency let a real wrong-recipient send through silently when
 * extraction came back empty. Only an actual, extracted, matching pair is considered safe.
 */
export function verifyRecipientName(
  expectedName: string,
  dialogText: string
): { ok: boolean; recipientName: string } {
  const recipientName = extractDialogRecipientName(dialogText);
  if (!expectedName || !recipientName) {
    return { ok: false, recipientName };
  }
  return { ok: namesPlausiblyMatch(expectedName, recipientName), recipientName };
}

/**
 * Pure: extracts the `/in/<slug>` segment from a LinkedIn profile URL, lowercased. Returns
 * '' if no such segment is found. Exported for unit testing.
 */
export function extractProfileSlug(url: string): string {
  const match = url.match(/\/in\/([^/?#]+)/i);
  return match ? match[1].toLowerCase() : '';
}

/**
 * Pure: independent, text-free safety net — verifies the browser is still on the originally
 * requested profile right before the note is filled / Send is clicked, comparing slugs (not
 * exact URL equality) to tolerate redirects/query params. FAIL-CLOSED: an unparseable slug on
 * either side blocks, same rationale as verifyRecipientName above.
 */
export function verifyProfileUrl(
  expectedUrl: string,
  actualUrl: string
): { ok: boolean; expectedSlug: string; actualSlug: string } {
  const expectedSlug = extractProfileSlug(expectedUrl);
  const actualSlug = extractProfileSlug(actualUrl);
  return { ok: Boolean(expectedSlug) && expectedSlug === actualSlug, expectedSlug, actualSlug };
}

// Bounded, non-throwing waits below: `Locator.click()` only auto-waits for the clicked
// element itself, not for whatever it triggers, and `Locator.count()` doesn't retry — so
// without these, the next `.count()` check can race a render and report "not found"
// prematurely. Each swallows its own timeout and falls through to the caller's existing
// `.count()` check, which resolves to the pre-existing failure path — never throws.
const MENU_RENDER_TIMEOUT_MS = 8000;

async function waitForConnectMenu(page: Pick<Page, 'locator'>): Promise<void> {
  await page
    .locator(SELECTORS.connectMenuItem)
    .first()
    .waitFor({ state: 'visible', timeout: MENU_RENDER_TIMEOUT_MS })
    .catch(() => {});
}

const CONNECT_DIALOG_TIMEOUT_MS = 8000;

async function waitForConnectDialog(page: Pick<Page, 'locator'>): Promise<void> {
  const anySelector = [SELECTORS.addNoteButton, SELECTORS.sendButton].join(', ');
  await page
    .locator(anySelector)
    .first()
    .waitFor({ state: 'visible', timeout: CONNECT_DIALOG_TIMEOUT_MS })
    .catch(() => {});
}

const NOTE_TRANSITION_TIMEOUT_MS = 8000;

// How long to keep polling (reload + check) for the "Pending" button after Send, and how
// long each poll attempt waits before reloading again — this is the fallback path, used only
// when the faster network-response confirmation (below) doesn't fire. Bumped from 30s to 90s
// after repeated live evidence that 30s isn't consistently enough for real propagation.
const PENDING_CONFIRMATION_TIMEOUT_MS = 90000;
const PENDING_CONFIRMATION_POLL_MS = 5000;

// Bounded wait for the network to settle after navigating to a profile — `domcontentloaded`
// fires before LinkedIn's React app hydrates the header action row.
const PROFILE_HEADER_SETTLE_TIMEOUT_MS = 8000;

// Bounded wait for the send-invitation API response right after clicking Send — much faster
// than reload+poll when it fires.
const NETWORK_CONFIRMATION_TIMEOUT_MS = 12000;

// Best-effort heuristic, NOT verified against a real captured request (no live browser
// access): a POST to a "voyager"-style path mentioning invitation/connect/relationship, 2xx.
export function isLikelySendInvitationResponse(response: Response): boolean {
  const url = response.url().toLowerCase();
  const isLikelyPath = url.includes('voyager') && /invitation|connect|relationship/.test(url);
  return (
    isLikelyPath &&
    response.request().method() === 'POST' &&
    response.status() >= 200 &&
    response.status() < 300
  );
}

async function waitForNoteDialogTransition(page: Pick<Page, 'locator'>): Promise<void> {
  const anySelector = [SELECTORS.noteTextarea, SELECTORS.sendButton].join(', ');
  await page
    .locator(anySelector)
    .first()
    .waitFor({ state: 'visible', timeout: NOTE_TRANSITION_TIMEOUT_MS })
    .catch(() => {});
}

/**
 * Pure: given the bounding-box heights of every `SELECTORS.moreButton` match, picks the
 * index of the first button-shaped one (height >= minHeightPx) — the real profile-header
 * "More" action, as opposed to small "…more" show-more-text toggles. Returns -1 if none
 * qualify. Exported for unit testing without a live Playwright page.
 */
export function pickButtonShapedIndex(boxes: Array<{ height: number }>, minHeightPx = 40): number {
  return boxes.findIndex((box) => box.height >= minHeightPx);
}

/**
 * Pure: extracts the clean visible name/headline from a result card's collected
 * profile-link texts and span texts. Exported for unit testing without a live page.
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

  // Gate first, before any Playwright action.
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

    // Locators (not ElementHandles) throughout — a Locator re-resolves at action time, so
    // it survives LinkedIn's dynamic re-renders.
    const resultCardsLocator = page.locator(SELECTORS.resultCard);
    const cardCount = await resultCardsLocator.count();
    const candidates: ProfileCandidate[] = [];

    for (let i = 0; i < Math.min(cardCount, 3); i++) {
      const card = resultCardsLocator.nth(i);
      const profileLinksLocator = card.locator(SELECTORS.profileLink);
      const linkCount = await profileLinksLocator.count();

      // Only indices 0/1 are consumed below — extra matches are unrelated mutual-connection
      // avatar links, and were observed to hang/timeout live if queried.
      const profileLinkTexts: string[] = [];
      for (let j = 0; j < Math.min(linkCount, 2); j++) {
        profileLinkTexts.push(((await profileLinksLocator.nth(j).textContent()) ?? '').trim());
      }
      // The clean-name link is the SECOND match within a card; fall back to the first.
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
  const fallback = {
    enabled: deps.fallbackEnabled ?? (Boolean(deps.fallback) || process.env.CONNECT_HYBRID_FALLBACK === 'true'),
    deps: deps.fallback,
  };
  const debugScreenshots =
    deps.debugScreenshots ?? process.env.CONNECT_DEBUG_SCREENSHOTS === 'true';

  // Cheap pre-flight checks run before the rate-limit gate, so a rejection never burns a
  // quota slot for a no-op that was never going to touch Playwright.
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

  // Gate immediately before the Playwright launch.
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
    // Wait for the network to settle — `domcontentloaded` fires before the profile-header
    // action row (Connect/Follow/Pending) finishes hydrating.
    await page.waitForLoadState('networkidle', { timeout: PROFILE_HEADER_SETTLE_TIMEOUT_MS }).catch(() => {});
    await captureDebugScreenshot(page, debugScreenshots, '01-profile-loaded');

    // The profile owner's own name, from the page title (not `<h1>` — confirmed missing
    // entirely on a real profile), captured before any click for the mandatory
    // recipient-name verification gate below and as the proximity anchor below.
    const expectedName = extractExpectedNameFromTitle((await page.title().catch(() => '')) ?? '');
    const namePoint = await getProfileNamePoint(page, expectedName);

    // Step 0: some profiles show "Connect" directly at the top level instead of hiding it
    // behind "More" — check that first, picking whichever match sits closest to the name.
    const directConnectLocator = await pickNearestLocator(page, SELECTORS.directConnectButton, namePoint);
    const hasDirectConnect = (await directConnectLocator.count()) > 0;

    if (hasDirectConnect) {
      await directConnectLocator.click();
      await captureDebugScreenshot(page, debugScreenshots, '02-direct-connect-clicked');
    } else {
      // Step 1: click the profile-header "More" button, filtered to the button-shaped
      // match via bounding-box heights (see pickButtonShapedIndex above).
      const moreButtonsLocator = page.locator(SELECTORS.moreButton);
      const moreButtonCount = await moreButtonsLocator.count();
      let moreButtonIndex = -1;
      if (moreButtonCount > 0) {
        const moreButtonBoxes = await moreButtonsLocator.evaluateAll((els) =>
          els.map((el) => ({ height: el.getBoundingClientRect().height }))
        );
        moreButtonIndex = pickButtonShapedIndex(moreButtonBoxes);
      }

      if (moreButtonIndex !== -1) {
        await moreButtonsLocator.nth(moreButtonIndex).click();
      } else {
        // No button-shaped match — escalate directly (this check isn't a plain
        // `count() > 0`, so it can't go through findAndClickControl's shared handling).
        const clickedMore =
          fallback.enabled &&
          (await escalateClick(
            page,
            'Open the profile-header overflow menu that contains "Connect" (a button-shaped ' +
              '"More" control, not a small post "…more" text toggle)',
            fallback
          ));
        if (!clickedMore) {
          return {
            status: 'failed',
            reason:
              moreButtonCount === 0
                ? 'More button not found on profile'
                : 'no button-shaped More button found on profile',
          };
        }
      }
      await waitForConnectMenu(page);
      await captureDebugScreenshot(page, debugScreenshots, '02-more-menu-open');

      // Step 2: click "Connect" inside the opened overflow menu.
      const clickedConnectMenuItem = await findAndClickControl(
        page,
        SELECTORS.connectMenuItem,
        'Click "Connect" inside the currently open profile overflow menu',
        fallback,
        '[role="menu"] [role="menuitem"]'
      );
      if (!clickedConnectMenuItem) {
        return { status: 'failed', reason: 'Connect menu item not found after opening More menu' };
      }
    }
    await waitForConnectDialog(page);
    await captureDebugScreenshot(page, debugScreenshots, '03-connect-dialog-open');

    // Independent, text-free safety net: confirm the browser is still on the requested
    // profile right before the note is filled / Send is clicked. Runs before the name check
    // since it doesn't depend on parsing any visible text.
    const urlCheck = verifyProfileUrl(profile_url, page.url());
    if (!urlCheck.ok) {
      await captureDebugScreenshot(page, debugScreenshots, '03a-url-mismatch');
      return {
        status: 'failed',
        reason:
          `profile URL mismatch: expected profile slug "${urlCheck.expectedSlug}" but the ` +
          `browser is currently on "${urlCheck.actualSlug}" — aborting before filling the ` +
          'note or clicking Send',
      };
    }

    // Mandatory recipient-name verification safety net — runs for BOTH the direct-Connect
    // and More-menu paths (both reach this point), before any note is filled or Send is
    // clicked. This is the gate against ANY selector picking the wrong link. FAIL-CLOSED:
    // an unverifiable name (either side empty) blocks rather than allows — see
    // verifyRecipientName's doc comment.
    const dialogTextLocator = page.locator(SELECTORS.noteDialogContainer).first();
    const dialogText = ((await dialogTextLocator.count()) > 0 ? await dialogTextLocator.textContent() : '') ?? '';
    const { ok: recipientOk, recipientName } = verifyRecipientName(expectedName, dialogText);
    if (!recipientOk) {
      await captureDebugScreenshot(page, debugScreenshots, '03b-recipient-name-mismatch');
      return {
        status: 'failed',
        reason: recipientName
          ? `recipient name mismatch: the connect dialog addresses "${recipientName}" but the ` +
            `profile navigated to is "${expectedName}" — aborting before filling the note or ` +
            'clicking Send to avoid sending to the wrong person'
          : `could not verify the connect dialog's recipient name (expected "${expectedName}") — ` +
            'aborting before filling the note or clicking Send',
      };
    }

    const addNoteButtonLocator = page.locator(SELECTORS.addNoteButton);
    if ((await addNoteButtonLocator.count()) > 0) {
      await addNoteButtonLocator.first().click();
      await waitForNoteDialogTransition(page);
      const noteInputLocator = page.locator(SELECTORS.noteTextarea);
      if ((await noteInputLocator.count()) > 0) {
        await noteInputLocator.first().fill(note);
      }
      await captureDebugScreenshot(page, debugScreenshots, '04-note-filled');
    }

    // Start listening for the send-invitation API response BEFORE clicking Send, so a fast
    // response can't resolve before we start awaiting it.
    const networkConfirmationPromise = page
      .waitForResponse(isLikelySendInvitationResponse, { timeout: NETWORK_CONFIRMATION_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);

    const clickedSend = await findAndClickControl(
      page,
      SELECTORS.sendButton,
      'Send the LinkedIn connection request from the currently open invite dialog (a ' +
        '"Send"/"Send invitation" button)',
      fallback
    );
    if (!clickedSend) {
      await captureDebugScreenshot(page, debugScreenshots, '05-send-button-not-found');
      return { status: 'failed', reason: 'Send button not found on connect dialog' };
    }
    await captureDebugScreenshot(page, debugScreenshots, '06-immediately-after-send-click');

    // Fast path: a matching 2xx API response is a much more authoritative and quicker signal
    // than waiting for the UI to visually update.
    let pendingConfirmed = await networkConfirmationPromise;

    if (!pendingConfirmed) {
      // Don't trust the click alone — a click can silently no-op. This DOM-disappearance wait
      // is a fast diagnostic capture only; it is NOT the basis for the sent/failed decision.
      await page
        .locator(SELECTORS.sendButton)
        .first()
        .waitFor({ state: 'hidden', timeout: 10000 })
        .catch(() => {});
      await captureDebugScreenshot(page, debugScreenshots, '07-after-dialog-dismiss-wait');

      // Fallback confirmation gate: reload the profile and poll for LinkedIn's own "Pending"
      // action button, which replaces "Follow" once the request is actually recorded.
      const pendingTimeoutMs = deps.pendingConfirmationTimeoutMs ?? PENDING_CONFIRMATION_TIMEOUT_MS;
      const pendingPollMs = deps.pendingConfirmationPollMs ?? PENDING_CONFIRMATION_POLL_MS;
      const deadline = Date.now() + pendingTimeoutMs;
      do {
        await page.goto(profile_url, { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(() => {});
        // Same "checked too early" fix as the initial load — let the reloaded page hydrate
        // before checking for the Pending button.
        await page.waitForLoadState('networkidle', { timeout: PROFILE_HEADER_SETTLE_TIMEOUT_MS }).catch(() => {});
        // Re-derive the name anchor each reload (fresh DOM) and pick the nearest match.
        const pendingNamePoint = await getProfileNamePoint(page, expectedName);
        pendingConfirmed = await (await pickNearestLocator(page, SELECTORS.pendingButton, pendingNamePoint))
          .waitFor({ state: 'visible', timeout: pendingPollMs })
          .then(() => true)
          .catch(() => false);
      } while (!pendingConfirmed && Date.now() < deadline);
    }

    await captureDebugScreenshot(
      page,
      debugScreenshots,
      pendingConfirmed ? '08-pending-confirmed' : '08-pending-not-found'
    );

    if (!pendingConfirmed) {
      return {
        status: 'failed',
        reason:
          'clicked Send but the "Pending" button never appeared on the profile — connection ' +
          'request was not confirmed. Verify manually on LinkedIn.',
      };
    }

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
 * `drafted`/`skipped` row so the orchestrator has a tool to call without ever touching
 * connect_send. No Playwright, no rate-limit gating.
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
      "LinkedIn's 300-character note cap. Set debug_screenshots=true to save a screenshot at each " +
      'step to debug/connect/ (gitignored) — useful when investigating a suspected false-positive ' +
      "'sent' result.",
    inputSchema: {
      profile_url: z.string(),
      note: z.string(),
      job_id: z.string().optional(),
      company: z.string().optional(),
      debug_screenshots: z.boolean().optional(),
    },
  },
  async ({ profile_url, note, job_id, company, debug_screenshots }) => {
    const result = await connectSend(
      { profile_url, note, job_id, company },
      { debugScreenshots: debug_screenshots }
    );
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
