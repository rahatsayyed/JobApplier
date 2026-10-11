import { describe, it, expect } from 'vitest';
import { assessLegitimacy } from '../src/legitimacy.js';

const long = 'We build developer tools. You will own React and TypeScript features with our design team. '.repeat(5);
const base = { id: 'remotive:1', title: 'React Developer', description: long, url: 'https://remotive.com/jobs/1', apply_url: 'https://boards.greenhouse.io/acme/jobs/1', repost_count: 0, age_days: 3 };

describe('assessLegitimacy', () => {
  it('a normal posting is high', () => {
    expect(assessLegitimacy(base)).toEqual({ tier: 'high', signals: [] });
  });
  it('asking the applicant for money is suspicious', () => {
    expect(assessLegitimacy({ ...base, description: `${long} A refundable security deposit of Rs 5000 is required.` })).toEqual({ tier: 'suspicious', signals: ['asks the applicant for a fee or deposit'] });
  });
  it('anti-scam disclaimers, employer-paid fees and "a day off" are NOT suspicious', () => {
    for (const s of [
      'We never charge a registration fee.',
      'There is no security deposit or registration fee for any role.',
      'We pay the fee for your AWS certification.',
      'Employees earn a day off each week.',
      'We reimburse the training fee after you join.',
      'Earn 2 days off each month.',
    ]) expect(assessLegitimacy({ ...base, description: `${long} ${s}` })).toEqual({ tier: 'high', signals: [] });
  });
  it('real fee demands and money-per-day pitches stay suspicious', () => {
    expect(assessLegitimacy({ ...base, description: `${long} Pay a registration fee to start.` }).tier).toBe('suspicious');
    expect(assessLegitimacy({ ...base, description: `${long} Selected candidates must pay a training fee of Rs 3000.` }).tier).toBe('suspicious');
    expect(assessLegitimacy({ ...base, description: `${long} Earn Rs 2000 per day working from home.` })).toEqual({ tier: 'suspicious', signals: ['"earn per day/week" pay pitch'] });
    expect(assessLegitimacy({ ...base, description: `${long} Earn up to $500 a week, no experience needed.` }).tier).toBe('suspicious');
  });
  it('shortener or chat apply links are suspicious', () => {
    expect(assessLegitimacy({ ...base, apply_url: 'https://bit.ly/abc' }).tier).toBe('suspicious');
    expect(assessLegitimacy({ ...base, apply_url: 'https://wa.me/919999999999' }).tier).toBe('suspicious');
    expect(assessLegitimacy({ ...base, apply_url: 'https://evil-bit.ly.example.com/x' }).tier).toBe('high');
  });
  it('reposts, age and thin descriptions are caution', () => {
    expect(assessLegitimacy({ ...base, repost_count: 2 })).toEqual({ tier: 'caution', signals: ['reposted 2 times in 90 days on the same board'] });
    expect(assessLegitimacy({ ...base, age_days: 61 }).signals).toEqual(['posted 61 days ago']);
    expect(assessLegitimacy({ ...base, description: 'React dev needed.' }).signals).toEqual(['thin description (17 chars)']);
    expect(assessLegitimacy({ ...base, id: 'li-post:9', description: 'Hiring React devs, DM me.' }).tier).toBe('high');
  });
  it('thin-description caution skips snippet sources unless a snapshot exists, and measures description OR snapshot length', () => {
    expect(assessLegitimacy({ ...base, source: 'linkedin-jobs', description: 'India (Remote)' })).toEqual({ tier: 'high', signals: [] });
    expect(assessLegitimacy({ ...base, source: 'naukri', description: 'Bengaluru' }).tier).toBe('high');
    expect(assessLegitimacy({ ...base, source: 'adzuna', description: 'Short snippet...' }).tier).toBe('high');
    expect(assessLegitimacy({ ...base, source: 'remotive', description: 'React dev needed.' }).signals).toEqual(['thin description (17 chars)']);
    expect(assessLegitimacy({ ...base, source: 'remotive', description: 'React dev needed.', snapshot_chars: 5000 }).tier).toBe('high');
    expect(assessLegitimacy({ ...base, source: 'naukri', description: 'Bengaluru', snapshot_chars: 150 }).signals).toEqual(['thin description (150 chars)']);
  });
  it('personal-channel applications are caution; fixed-term is informational', () => {
    expect(assessLegitimacy({ ...base, description: `${long} Send your CV on WhatsApp to apply.` }).tier).toBe('caution');
    expect(assessLegitimacy({ ...base, description: `${long} Email your resume to hr.acme@gmail.com.` }).signals).toEqual(['applications go to a personal mailbox or chat app']);
    expect(assessLegitimacy({ ...base, description: `${long} This is a 6 month contract.` })).toEqual({ tier: 'high', signals: ['info: fixed-term contract'] });
  });
  it('missing both URLs is caution', () => {
    expect(assessLegitimacy({ ...base, url: null, apply_url: '' }).signals).toEqual(['no posting or apply URL']);
  });
});
