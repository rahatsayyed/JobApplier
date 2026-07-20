import BetterSqlite3 from 'better-sqlite3';

export function openDb(path: string = 'data.sqlite'): BetterSqlite3.Database {
  const db = new BetterSqlite3(path);

  // Create tables if they don't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      source TEXT,
      title TEXT,
      company TEXT,
      url TEXT,
      apply_url TEXT,
      description TEXT,
      score INTEGER,
      status TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company TEXT,
      email TEXT,
      type TEXT,
      verified INTEGER,
      source TEXT,
      confidence REAL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS outreach (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT,
      contact_email TEXT,
      subject TEXT,
      body TEXT,
      resume_path TEXT,
      sent_at TEXT,
      status TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS daily_counters (
      day TEXT,
      key TEXT,
      count INTEGER DEFAULT 0,
      PRIMARY KEY (day, key)
    );

    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT,
      platform TEXT,
      method TEXT,
      account TEXT,
      status TEXT,
      reason TEXT,
      applied_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT,
      company TEXT,
      profile_url TEXT,
      headline TEXT,
      note TEXT,
      status TEXT,
      sent_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS outreach_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      resume_pdf_path TEXT,
      email_subject TEXT,
      email_body TEXT,
      email_to TEXT,
      email_status TEXT,
      connect_note TEXT,
      connect_profile_url TEXT,
      connect_category TEXT,
      connect_company TEXT,
      connect_status TEXT,
      apply_platform TEXT,
      apply_url TEXT,
      apply_status TEXT,
      status TEXT DEFAULT 'queued',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Migration: older databases created before `method`/`account` existed on
  // `applications` (added for linkedin-apply's Easy Apply tracking). Add them
  // if missing so existing data.sqlite files don't break.
  const applicationColumns = db.prepare("PRAGMA table_info(applications)").all() as Array<{ name: string }>;
  const columnNames = new Set(applicationColumns.map((c) => c.name));
  if (!columnNames.has('method')) {
    db.exec('ALTER TABLE applications ADD COLUMN method TEXT');
  }
  if (!columnNames.has('account')) {
    db.exec('ALTER TABLE applications ADD COLUMN account TEXT');
  }

  // Migration: older databases created before `connect_company` existed on
  // `outreach_queue`. Add it if missing so existing data.sqlite files don't break.
  const outreachQueueColumns = db.prepare("PRAGMA table_info(outreach_queue)").all() as Array<{ name: string }>;
  const outreachQueueColumnNames = new Set(outreachQueueColumns.map((c) => c.name));
  if (!outreachQueueColumnNames.has('connect_company')) {
    db.exec('ALTER TABLE outreach_queue ADD COLUMN connect_company TEXT');
  }

  return db;
}

export function isSeen(db: BetterSqlite3.Database, id: string): boolean {
  const result = db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(id);
  return result !== undefined;
}

export interface Job {
  id: string;
  source: string;
  title: string;
  company: string;
  url: string;
  apply_url: string;
  description: string;
  score?: number;
  status?: string;
}

export function saveJob(db: BetterSqlite3.Database, job: Job): void {
  db.prepare(`
    INSERT OR IGNORE INTO jobs (id, source, title, company, url, apply_url, description, score, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    job.id,
    job.source,
    job.title,
    job.company,
    job.url,
    job.apply_url,
    job.description,
    job.score ?? null,
    job.status ?? null
  );
}

export function getJob(db: BetterSqlite3.Database, id: string): Job | undefined {
  const result = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as any;
  return result ? {
    id: result.id,
    source: result.source,
    title: result.title,
    company: result.company,
    url: result.url,
    apply_url: result.apply_url,
    description: result.description,
    score: result.score,
    status: result.status,
  } : undefined;
}

export interface Contact {
  company: string;
  email: string;
  type: string;
  verified: boolean;
  source: string;
  confidence?: number;
}

export function saveContact(db: BetterSqlite3.Database, contact: Contact): void {
  db.prepare(`
    INSERT INTO contacts (company, email, type, verified, source, confidence)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    contact.company,
    contact.email,
    contact.type,
    contact.verified ? 1 : 0,
    contact.source,
    contact.confidence ?? null
  );
}

export interface Outreach {
  job_id: string;
  contact_email: string;
  subject: string;
  body: string;
  resume_path: string;
  status?: string;
}

export function saveOutreach(db: BetterSqlite3.Database, outreach: Outreach): void {
  db.prepare(`
    INSERT INTO outreach (job_id, contact_email, subject, body, resume_path, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    outreach.job_id,
    outreach.contact_email,
    outreach.subject,
    outreach.body,
    outreach.resume_path,
    outreach.status ?? null
  );
}

export interface Application {
  job_id: string;
  platform: string | null;
  method?: string | null;
  account?: string | null;
  status: 'submitted' | 'manual_review' | 'failed';
  reason?: string | null;
  applied_at?: string | null;
}

export function saveApplication(db: BetterSqlite3.Database, application: Application): void {
  db.prepare(`
    INSERT INTO applications (job_id, platform, method, account, status, reason, applied_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    application.job_id,
    application.platform ?? null,
    application.method ?? null,
    application.account ?? null,
    application.status,
    application.reason ?? null,
    application.applied_at ?? null
  );
}

export interface Connection {
  job_id?: string | null;
  company?: string | null;
  profile_url: string;
  headline?: string | null;
  note: string;
  status: 'drafted' | 'approved' | 'sent' | 'skipped';
  sent_at?: string | null;
}

export function saveConnection(db: BetterSqlite3.Database, connection: Connection): void {
  db.prepare(`
    INSERT INTO connections (job_id, company, profile_url, headline, note, status, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    connection.job_id ?? null,
    connection.company ?? null,
    connection.profile_url,
    connection.headline ?? null,
    connection.note,
    connection.status,
    connection.sent_at ?? null
  );
}

export interface OutreachQueueItem {
  id: number;
  job_id: string;
  resume_pdf_path: string | null;
  email_subject: string | null;
  email_body: string | null;
  email_to: string | null;
  email_status: string | null;
  connect_note: string | null;
  connect_profile_url: string | null;
  connect_category: string | null;
  connect_company: string | null;
  connect_status: string | null;
  apply_platform: string | null;
  apply_url: string | null;
  apply_status: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export function enqueueOutreach(
  db: BetterSqlite3.Database,
  item: {
    job_id: string;
    resume_pdf_path: string | null;
    email_subject: string | null;
    email_body: string | null;
    email_to: string | null;
    connect_note: string | null;
    connect_profile_url: string | null;
    connect_category: string | null;
    connect_company: string | null;
    apply_platform: string | null;
    apply_url: string | null;
  }
): number {
  const result = db.prepare(`
    INSERT INTO outreach_queue (
      job_id, resume_pdf_path, email_subject, email_body, email_to,
      connect_note, connect_profile_url, connect_category, connect_company,
      apply_platform, apply_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.job_id,
    item.resume_pdf_path,
    item.email_subject,
    item.email_body,
    item.email_to,
    item.connect_note,
    item.connect_profile_url,
    item.connect_category,
    item.connect_company,
    item.apply_platform,
    item.apply_url
  );
  return Number(result.lastInsertRowid);
}

export function listQueuedOutreach(db: BetterSqlite3.Database): OutreachQueueItem[] {
  return db
    .prepare(`SELECT * FROM outreach_queue WHERE status = 'queued' ORDER BY created_at ASC`)
    .all() as OutreachQueueItem[];
}

const UPDATABLE_FIELDS = ['email_status', 'connect_status', 'apply_status', 'status'] as const;

export function updateOutreachStatus(
  db: BetterSqlite3.Database,
  id: number,
  field: (typeof UPDATABLE_FIELDS)[number],
  value: string
): void {
  if (!UPDATABLE_FIELDS.includes(field)) {
    throw new Error(`updateOutreachStatus: invalid field "${field}"`);
  }
  db.prepare(`UPDATE outreach_queue SET ${field} = ?, updated_at = datetime('now') WHERE id = ?`).run(value, id);
}
