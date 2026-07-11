import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  validateNoteLength,
  findLinkedinProfile,
  connectSend,
} from '../src/mcp/connect.js';
import { openDb } from '../src/db.js';
import type Database from 'better-sqlite3';

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
});
