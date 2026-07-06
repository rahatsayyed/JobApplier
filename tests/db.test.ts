import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, isSeen, saveJob, getJob, saveContact, saveOutreach } from '../src/db';
import type Database from 'better-sqlite3';

describe('db', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('should save a job and check if it is seen', () => {
    const job = {
      id: 'job-001',
      source: 'linkedin',
      title: 'Software Engineer',
      company: 'Acme Corp',
      url: 'https://example.com/job/001',
      apply_url: 'https://example.com/apply/001',
      description: 'Build awesome stuff',
    };

    saveJob(db, job);
    expect(isSeen(db, 'job-001')).toBe(true);
    expect(isSeen(db, 'nope')).toBe(false);
  });

  it('should return saved job via getJob', () => {
    const job = {
      id: 'job-002',
      source: 'indeed',
      title: 'Data Scientist',
      company: 'Tech Inc',
      url: 'https://example.com/job/002',
      apply_url: 'https://example.com/apply/002',
      description: 'Analyze data',
    };

    saveJob(db, job);
    const retrieved = getJob(db, 'job-002');
    expect(retrieved).toBeDefined();
    expect(retrieved?.title).toBe('Data Scientist');
  });

  it('should store contact with verified as integer', () => {
    const contact = {
      company: 'Acme Corp',
      email: 'contact@acme.com',
      type: 'email',
      verified: true,
      source: 'linkedin',
      confidence: 0.95,
    };

    saveContact(db, contact);

    const result = db.prepare('SELECT verified FROM contacts WHERE email = ?').get(contact.email) as any;
    expect(result).toBeDefined();
    expect(result.verified).toBe(1);
  });

  it('should insert outreach record', () => {
    // First save a job so we have a valid foreign key reference
    const job = {
      id: 'job-003',
      source: 'glassdoor',
      title: 'Backend Engineer',
      company: 'DevCo',
      url: 'https://example.com/job/003',
      apply_url: 'https://example.com/apply/003',
      description: 'Build backend services',
    };
    saveJob(db, job);

    const outreach = {
      job_id: 'job-003',
      contact_email: 'dev@devco.com',
      subject: 'Interested in Backend Engineer role',
      body: 'Hello, I am interested...',
      resume_path: '/path/to/resume.pdf',
    };

    saveOutreach(db, outreach);

    const count = (db.prepare('SELECT COUNT(*) as cnt FROM outreach').get() as any).cnt;
    expect(count).toBe(1);
  });
});
