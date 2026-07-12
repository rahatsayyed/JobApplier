import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  validateNoteLength,
  findLinkedinProfile,
  connectSend,
  extractNameAndHeadline,
  pickButtonShapedIndex,
  SELECTORS,
} from '../src/mcp/connect.js';
import { openDb } from '../src/db.js';
import type Database from 'better-sqlite3';

/**
 * A minimal fake Playwright element: `click`/`fill` are spies so tests can assert
 * whether a connect/note/send action was ever attempted.
 */
function makeFakeElement() {
  return {
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * A minimal fake Playwright `Locator` wrapping zero-or-one fake element(s) — mirrors the
 * shape used in tests/linkedin-apply.test.ts for its Locator conversion.
 */
function makeFakeLocator(el: ReturnType<typeof makeFakeElement> | null): any {
  const locator: any = {
    count: vi.fn().mockResolvedValue(el ? 1 : 0),
    click: vi.fn(async () => {
      if (!el) throw new Error('no element matched by locator');
      return el.click();
    }),
    fill: vi.fn(async (value: string) => {
      if (!el) throw new Error('no element matched by locator');
      return el.fill(value);
    }),
  };
  locator.first = vi.fn(() => locator);
  return locator;
}

/**
 * A fake multi-match Locator backed by an array of fake elements and their bounding-box
 * heights — mirrors `page.locator(SELECTORS.moreButton)`, which can match several elements
 * on a real profile page. `nth(i)` returns a fake Locator wrapping just that element.
 */
function makeFakeMultiLocator(elements: Array<ReturnType<typeof makeFakeElement>>, heights: number[]): any {
  const locator: any = {
    count: vi.fn().mockResolvedValue(elements.length),
    evaluateAll: vi.fn().mockResolvedValue(heights.map((height) => ({ height }))),
    nth: vi.fn((i: number) => makeFakeLocator(elements[i] ?? null)),
  };
  return locator;
}

/**
 * A fake "result card" locator representing `page.locator(SELECTORS.resultCard)`, backed
 * by an array of card descriptors. Each card exposes `.locator(selector)` for the nested
 * profile-link / span lookups `findLinkedinProfile` performs on it.
 */
function makeFakeResultCardsLocator(
  cards: Array<{ linkTexts: string[]; linkHrefs: string[]; spanTexts: string[] }>
) {
  const cardsLocator: any = {
    count: vi.fn().mockResolvedValue(cards.length),
    nth: vi.fn((i: number) => {
      const card = cards[i];
      return {
        locator: vi.fn((selector: string) => {
          if (selector === 'span') {
            return {
              evaluateAll: vi.fn().mockResolvedValue(card.spanTexts),
            };
          }
          // profileLink selector
          const linksLocator: any = {
            count: vi.fn().mockResolvedValue(card.linkTexts.length),
            nth: vi.fn((j: number) => ({
              textContent: vi.fn().mockResolvedValue(card.linkTexts[j]),
              getAttribute: vi.fn().mockResolvedValue(card.linkHrefs[j]),
            })),
          };
          return linksLocator;
        }),
      };
    }),
  };
  return cardsLocator;
}

describe('validateNoteLength', () => {
  it('accepts a note at or under the 300-character LinkedIn cap', () => {
    const note = 'a'.repeat(300);
    expect(validateNoteLength(note)).toEqual({ ok: true, length: 300 });
  });

  it('rejects a note over the 300-character cap', () => {
    const note = 'a'.repeat(301);
    expect(validateNoteLength(note)).toEqual({ ok: false, length: 301 });
  });

  it('rejects an empty note', () => {
    expect(validateNoteLength('')).toEqual({ ok: false, length: 0 });
  });

  it('accepts a short, realistic note', () => {
    const note = 'Hi Jordan, saw the Full Stack Developer opening at Acme — would love to connect!';
    const result = validateNoteLength(note);
    expect(result.ok).toBe(true);
    expect(result.length).toBe(note.length);
  });
});

describe('SELECTORS', () => {
  // Pure string assertions on the selector VALUES — proof that the old, live-confirmed-dead
  // selectors are gone, not proof the new ones resolve on a real page (only the live
  // inspection in .superpowers/sdd/task-6-connect-fix-report.md can confirm that).
  it('no longer relies on the obsolete reusable-search__result-container class for resultCard', () => {
    expect(SELECTORS.resultCard).not.toContain('reusable-search__result-container');
    expect(SELECTORS.resultCard).toContain('role="listitem"');
  });

  it('no longer relies on the obsolete app-aware-link class for profileLink', () => {
    expect(SELECTORS.profileLink).not.toContain('app-aware-link');
  });

  it('no longer assumes a direct Connect button is visible on the profile (More-menu flow instead)', () => {
    // Live finding: the tested profile had no top-level Connect button at all — Connect is
    // tucked inside the "More" overflow menu. `connectButton` is gone; `moreButton` +
    // `connectMenuItem` replace it.
    expect(SELECTORS).not.toHaveProperty('connectButton');
    expect(SELECTORS.moreButton).toContain('More');
    expect(SELECTORS.connectMenuItem).toContain('role="menu"');
    expect(SELECTORS.connectMenuItem).toContain('Connect');
  });
});

describe('pickButtonShapedIndex', () => {
  it('picks the first candidate at or above the button-shaped height threshold', () => {
    // Shaped after the live finding: index 0 was the real 48px-tall profile-header "More"
    // button; the rest were ~17.5px "…more" show-more-text toggles inside post captions.
    const boxes = [{ height: 48 }, { height: 17.5 }, { height: 17.5 }, { height: 17.5 }];
    expect(pickButtonShapedIndex(boxes)).toBe(0);
  });

  it('skips small candidates and picks the first later one that is button-shaped', () => {
    const boxes = [{ height: 17.5 }, { height: 17.5 }, { height: 48 }];
    expect(pickButtonShapedIndex(boxes)).toBe(2);
  });

  it('returns -1 when no candidate is button-shaped', () => {
    const boxes = [{ height: 17.5 }, { height: 20 }, { height: 0 }];
    expect(pickButtonShapedIndex(boxes)).toBe(-1);
  });

  it('returns -1 for an empty list', () => {
    expect(pickButtonShapedIndex([])).toBe(-1);
  });
});

describe('extractNameAndHeadline', () => {
  // Fixtures below are taken verbatim from a live people-search inspection (see
  // .superpowers/sdd/task-6-connect-fix-report.md) — real link/span text captured from
  // `https://www.linkedin.com/search/results/people/?keywords=InfoVision%20recruiter`.
  it('extracts the clean name from the second profileLink match, ignoring the concatenated wrapper link', () => {
    const linkTexts = [
      'Sundarraj Ganesha Sundarraj Ganesha  • 2ndTalent Acquisition Specialist | End-to-End Recruitment...',
      'Sundarraj Ganesha',
      'Ankit Ambardar',
      'Nikhil V.',
    ];
    const spanTexts = [
      '• 2nd',
      '• 2nd',
      'Talent Acquisition Specialist | End-to-End Recruitment | Delivering Talent Solutions',
      'Bengaluru, Karnataka, India',
    ];

    const { name, headline } = extractNameAndHeadline(linkTexts, spanTexts);

    expect(name).toBe('Sundarraj Ganesha');
    expect(headline).toBe('Talent Acquisition Specialist | End-to-End Recruitment | Delivering Talent Solutions');
  });

  it('falls back to the first link when only one profileLink match is present', () => {
    const { name } = extractNameAndHeadline(['Jordan Lee'], []);
    expect(name).toBe('Jordan Lee');
  });

  it('returns an empty headline when no connection-degree span is found', () => {
    const { headline } = extractNameAndHeadline(['A', 'B'], ['Some unrelated span text']);
    expect(headline).toBe('');
  });

  it('handles no matches at all without throwing', () => {
    expect(extractNameAndHeadline([], [])).toEqual({ name: '', headline: '' });
  });
});

describe('findLinkedinProfile control flow', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('returns rate_limited and never touches Playwright when the daily search limit is already reached', async () => {
    const launch = vi.fn();
    const fakeChromium = { launch };

    const result = await findLinkedinProfile(
      { company: 'Acme Corp' },
      { db, maxSearchesPerDay: 0, chromium: fakeChromium }
    );

    expect(result.status).toBe('rate_limited');
    expect(result.candidates).toEqual([]);
    // The rate-limit gate must be checked BEFORE any Playwright action — launch()
    // should never be invoked once the limit is already exhausted.
    expect(launch).not.toHaveBeenCalled();
  });

  it('returns candidates extracted via the Locator-based resultCard/profileLink flow', async () => {
    // Shaped after the live DOM pattern: two `a[href*="/in/"]` matches per card (a
    // concatenated wrapper link, then the clean name link), plus span texts holding the
    // connection-degree badge and headline.
    const cardsLocator = makeFakeResultCardsLocator([
      {
        linkTexts: [
          'Sundarraj Ganesha Sundarraj Ganesha  • 2ndTalent Acquisition Specialist...',
          'Sundarraj Ganesha',
        ],
        linkHrefs: [
          'https://www.linkedin.com/in/sundarraj-ganesha-93113815a/',
          'https://www.linkedin.com/in/sundarraj-ganesha-93113815a/',
        ],
        spanTexts: ['• 2nd', '• 2nd', 'Talent Acquisition Specialist', 'Bengaluru, Karnataka, India'],
      },
      {
        linkTexts: ['Nivetha SB Nivetha SB  • 2ndSenior Human Resource Recruiter...', 'Nivetha SB'],
        linkHrefs: [
          'https://www.linkedin.com/in/nivetha-sb-322a08139/',
          'https://www.linkedin.com/in/nivetha-sb-322a08139/',
        ],
        spanTexts: ['• 2nd', '• 2nd', 'Senior Human Resource Recruiter', 'Chennai, Tamil Nadu, India'],
      },
    ]);

    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockImplementation((selector: string) => {
        if (selector === SELECTORS.resultCard) return cardsLocator;
        return makeFakeLocator(null);
      }),
    };

    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const launch = vi.fn().mockResolvedValue(browser);
    const fakeChromium = { launch };

    const result = await findLinkedinProfile(
      { company: 'InfoVision' },
      { db, chromium: fakeChromium }
    );

    expect(result.status).toBe('ok');
    expect(result.candidates).toEqual([
      {
        profile_url: 'https://www.linkedin.com/in/sundarraj-ganesha-93113815a/',
        name: 'Sundarraj Ganesha',
        headline: 'Talent Acquisition Specialist',
      },
      {
        profile_url: 'https://www.linkedin.com/in/nivetha-sb-322a08139/',
        name: 'Nivetha SB',
        headline: 'Senior Human Resource Recruiter',
      },
    ]);
  });

  it('extracts the correct name/headline/url from a card with MORE than 2 profile links, never reading beyond index 1', async () => {
    // Live finding: a real result card can have 2, 3, or 4 `a[href*="/in/"]` matches — the
    // extras beyond index 1 are "mutual connections"/"also viewed" avatar links unrelated
    // to this result's own profile, and querying them was observed to hang/timeout live.
    // `nth(2)`/`nth(3)` below reject if ever called, proving findLinkedinProfile only reads
    // indices 0 and 1 (the indices extractNameAndHeadline actually consumes).
    const cardsLocator: any = {
      count: vi.fn().mockResolvedValue(1),
      nth: vi.fn((i: number) => {
        expect(i).toBe(0);
        return {
          locator: vi.fn((selector: string) => {
            if (selector === 'span') {
              return {
                evaluateAll: vi
                  .fn()
                  .mockResolvedValue(['• 2nd', '• 2nd', 'Talent Acquisition Specialist', 'Bengaluru, India']),
              };
            }
            const linkTexts = [
              'Sundarraj Ganesha Sundarraj Ganesha  • 2ndTalent Acquisition Specialist...',
              'Sundarraj Ganesha',
            ];
            const linkHrefs = [
              'https://www.linkedin.com/in/sundarraj-ganesha-93113815a/',
              'https://www.linkedin.com/in/sundarraj-ganesha-93113815a/',
            ];
            const linksLocator: any = {
              count: vi.fn().mockResolvedValue(4), // 4 links present on the real card
              nth: vi.fn((j: number) => {
                if (j >= 2) {
                  return {
                    textContent: vi.fn().mockRejectedValue(new Error(`unused mutual-connection link nth(${j}) queried`)),
                    getAttribute: vi.fn().mockRejectedValue(new Error(`unused mutual-connection link nth(${j}) queried`)),
                  };
                }
                return {
                  textContent: vi.fn().mockResolvedValue(linkTexts[j]),
                  getAttribute: vi.fn().mockResolvedValue(linkHrefs[j]),
                };
              }),
            };
            return linksLocator;
          }),
        };
      }),
    };

    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockImplementation((selector: string) => {
        if (selector === SELECTORS.resultCard) return cardsLocator;
        return makeFakeLocator(null);
      }),
    };

    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const launch = vi.fn().mockResolvedValue(browser);
    const fakeChromium = { launch };

    const result = await findLinkedinProfile(
      { company: 'InfoVision' },
      { db, chromium: fakeChromium }
    );

    expect(result.status).toBe('ok');
    expect(result.candidates).toEqual([
      {
        profile_url: 'https://www.linkedin.com/in/sundarraj-ganesha-93113815a/',
        name: 'Sundarraj Ganesha',
        headline: 'Talent Acquisition Specialist',
      },
    ]);
  });
});

describe('connectSend control flow', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('returns rate_limited and never touches Playwright when the daily connect limit is already reached', async () => {
    const launch = vi.fn();
    const fakeChromium = { launch };

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, maxConnectsPerDay: 0, chromium: fakeChromium }
    );

    expect(result.status).toBe('rate_limited');
    expect(launch).not.toHaveBeenCalled();
  });

  it('returns failed and never touches Playwright when the note exceeds the 300-character cap', async () => {
    const launch = vi.fn();
    const fakeChromium = { launch };
    const overLongNote = 'a'.repeat(301);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: overLongNote },
      { db, maxConnectsPerDay: 10, chromium: fakeChromium }
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/300-character/);
    expect(launch).not.toHaveBeenCalled();
  });

  it('returns failed and never proceeds when no More button is found on the profile', async () => {
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockImplementation(() => makeFakeMultiLocator([], [])),
    };
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, chromium: { launch } }
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/More button not found/);
  });

  it('returns failed when More buttons are found but none is button-shaped (e.g. only post "…more" toggles)', async () => {
    const smallToggle1 = makeFakeElement();
    const smallToggle2 = makeFakeElement();

    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockImplementation((selector: string) => {
        if (selector === SELECTORS.moreButton) {
          return makeFakeMultiLocator([smallToggle1, smallToggle2], [17.5, 17.5]);
        }
        return makeFakeLocator(null);
      }),
    };
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, chromium: { launch } }
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/no button-shaped More button/);
    expect(smallToggle1.click).not.toHaveBeenCalled();
    expect(smallToggle2.click).not.toHaveBeenCalled();
  });

  it('returns failed and never clicks send when the More menu has no Connect menu item', async () => {
    const moreButton = makeFakeElement();

    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockImplementation((selector: string) => {
        if (selector === SELECTORS.moreButton) return makeFakeMultiLocator([moreButton], [48]);
        if (selector === SELECTORS.connectMenuItem) return makeFakeLocator(null);
        return makeFakeLocator(null);
      }),
    };
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, chromium: { launch } }
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/Connect menu item not found/);
    expect(moreButton.click).toHaveBeenCalledTimes(1);
  });

  it('clicks More, then Connect in the opened menu, adds a note, and clicks send via the Locator API on the happy path', async () => {
    const moreButton = makeFakeElement();
    const connectMenuItem = makeFakeElement();
    const addNoteButton = makeFakeElement();
    const noteInput = makeFakeElement();
    const sendButton = makeFakeElement();

    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockImplementation((selector: string) => {
        // A real profile has several `SELECTORS.moreButton` matches (post "…more" toggles
        // etc.) — mirror that here with one small decoy plus the real 48px-tall button at
        // index 1, to prove pickButtonShapedIndex's filtering is actually exercised.
        if (selector === SELECTORS.moreButton) {
          const decoy = makeFakeElement();
          return makeFakeMultiLocator([decoy, moreButton], [17.5, 48]);
        }
        if (selector === SELECTORS.connectMenuItem) return makeFakeLocator(connectMenuItem);
        if (selector === SELECTORS.addNoteButton) return makeFakeLocator(addNoteButton);
        if (selector === SELECTORS.noteTextarea) return makeFakeLocator(noteInput);
        if (selector === SELECTORS.sendButton) return makeFakeLocator(sendButton);
        return makeFakeLocator(null);
      }),
    };
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await connectSend(
      { profile_url: 'https://linkedin.com/in/example', note: 'Hi, would love to connect!' },
      { db, chromium: { launch } }
    );

    expect(result.status).toBe('sent');
    expect(moreButton.click).toHaveBeenCalledTimes(1);
    expect(connectMenuItem.click).toHaveBeenCalledTimes(1);
    expect(addNoteButton.click).toHaveBeenCalledTimes(1);
    expect(noteInput.fill).toHaveBeenCalledWith('Hi, would love to connect!');
    expect(sendButton.click).toHaveBeenCalledTimes(1);
  });
});
