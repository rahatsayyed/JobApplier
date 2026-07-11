import { describe, it, expect } from 'vitest';
import { resolveAnswer, type EasyApplyAnswers } from '../src/mcp/linkedin-apply.js';

const answers: EasyApplyAnswers = {
  years_experience: 5,
  authorized_to_work: true,
  requires_sponsorship: false,
  willing_to_relocate: true,
  notice_period_days: 30,
  expected_salary: '25 LPA',
  phone: '+91-9999999999',
  linkedin_profile_url: 'https://linkedin.com/in/example',
};

describe('resolveAnswer', () => {
  it('matches "years of experience" style questions', () => {
    expect(resolveAnswer('How many years of experience do you have with React?', answers)).toBe(5);
    expect(resolveAnswer('Years of experience', answers)).toBe(5);
  });

  it('matches "authorized to work" style questions', () => {
    expect(resolveAnswer('Are you legally authorized to work in this country?', answers)).toBe(true);
  });

  it('matches sponsorship questions', () => {
    expect(
      resolveAnswer('Will you now or in the future require sponsorship for employment visa status?', answers)
    ).toBe(false);
  });

  it('matches relocation questions', () => {
    expect(resolveAnswer('Are you willing to relocate for this role?', answers)).toBe(true);
  });

  it('matches notice period questions', () => {
    expect(resolveAnswer('What is your current notice period (in days)?', answers)).toBe(30);
  });

  it('matches expected salary questions', () => {
    expect(resolveAnswer('What are your salary expectations?', answers)).toBe('25 LPA');
  });

  it('matches phone questions', () => {
    expect(resolveAnswer('Mobile phone number', answers)).toBe('+91-9999999999');
  });

  it('matches LinkedIn profile URL questions', () => {
    expect(resolveAnswer('Please share your LinkedIn profile URL', answers)).toBe(
      'https://linkedin.com/in/example'
    );
  });

  it('returns null for unrecognized questions', () => {
    expect(resolveAnswer('What is your favorite color?', answers)).toBeNull();
    expect(resolveAnswer('Describe a time you overcame a challenge at work.', answers)).toBeNull();
  });
});
