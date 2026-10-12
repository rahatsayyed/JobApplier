import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildReplyQuery, classifyReply, classifyReplyDetail, loadRepliesConfig, matchReply, stripQuoted, type ReplyClass } from '../src/replies.js';
import type { SentEmail } from '../src/db.js';

const sent = (over: Partial<SentEmail>): SentEmail => ({ job_id: 'j1', company: 'Acme Labs Pvt Ltd', title: 'Frontend Developer', email_to: 'hr@acme.dev', subject: 'Frontend role', body: 'Hi', message_id: 'm1', thread_id: 't1', sent_at: '2026-09-01 10:00:00', ...over });

describe('loadRepliesConfig (opt-in, safe default false)', () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-replies-cfg-'));
  const write = (name: string, text: string) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };
  it('is true only for a literal boolean true; missing, invalid or wrong-typed => false', () => {
    expect(loadRepliesConfig(write('on.json', '{"auto_record_enabled": true}'))).toEqual({ auto_record_enabled: true });
    expect(loadRepliesConfig(write('off.json', '{"auto_record_enabled": false}'))).toEqual({ auto_record_enabled: false });
    expect(loadRepliesConfig(path.join(dir, 'missing.json'))).toEqual({ auto_record_enabled: false });
    for (const bad of ['{not json', '[]', 'null', '{"auto_record_enabled": "true"}', '{"auto_record_enabled": 1}', '{}']) expect(loadRepliesConfig(write('bad.json', bad))).toEqual({ auto_record_enabled: false });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('the repository config ships disabled', () => {
    expect(JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config', 'replies.json'), 'utf8'))).toEqual({ auto_record_enabled: false });
    expect(loadRepliesConfig()).toEqual({ auto_record_enabled: false });
  });
});

describe('classifier precision (fix round 1)', () => {
  const H = 'Neha <neha@zentrix.in>';
  it.each([
    ['reschedule is not a rejection', 'Re: Interview', "We can't proceed with Monday's slot as the panel is unavailable. Can you do Tuesday at 4 instead?", H, 'replied'],
    ['rejection with a redirect after "but" is not a rejection', 'Re: FSD', 'You are not a fit for the junior role, but I would like to schedule a call for our senior opening.', H, 'replied'],
    ['negated offer is not an offer', 'Re: x', 'We are not extending an offer at this time.', H, 'rejected'],
    ['a bare scheduling verb with no time or day decides nothing', 'Re: x', 'Happy to set up a call at some point.', H, 'replied'],
    ['ATS auto-ack is not an interview', 'Thanks for applying', 'Hi Rahat, thanks for applying! Our team is reviewing applications and will be in touch soon.', 'Acme <no-reply@us.greenhouse-mail.io>', 'auto_ack'],
    ['job-board mailer is noise even with scheduling words', 'Interview tips', 'Schedule a mock interview today!', 'Naukri <info@naukri.com>', 'noise'],
    ['an "Invitation:" subject alone is not an interview', 'Invitation: Careers live session', 'Join us on Thursday.', H, 'noise'],
    ['a no-reply sender with nothing decisive is noise', 'Update', 'Some product news for you.', 'Acme <noreply@acme.dev>', 'noise'],
    ['leave types beyond vacation are out-of-office', 'Re: x', 'I am on Diwali leave and will be back on 4th Nov.', H, 'auto_ack'],
    ['process description is a plain reply', 'Re: x', 'Our process has three rounds: a technical round, a system design round and an HR round.', H, 'replied'],
  ] as Array<[string, string, string, string, ReplyClass]>)('%s', (_l, subject, body, from, expected) => {
    expect(classifyReply(subject, body, from)).toBe(expected);
  });
  it('eligibility: strong phrase and human sender only', () => {
    expect(classifyReplyDetail('Re: x', 'We regret to inform you that we will not move forward.', 'hr@acme.dev')).toEqual({ cls: 'rejected', eligible: true });
    expect(classifyReplyDetail('Re: x', 'On this occasion your application has been unsuccessful.', 'hr@acme.dev')).toEqual({ cls: 'rejected', eligible: false });
    expect(classifyReplyDetail('Re: x', 'Are you free Thursday at 3 pm for a call?', 'hr@acme.dev')).toEqual({ cls: 'interview', eligible: true });
    expect(classifyReplyDetail('Interview confirmed', 'Your interview has been scheduled for Oct 16, 10:00 AM.', 'no-reply@ashbyhq.com')).toEqual({ cls: 'interview', eligible: false });
  });
  it('unmarked greeting-quote, French header, hidden HTML, comments and entities', () => {
    expect(stripQuoted('Sure.\n\nHi Neha, could we schedule a call this week? Thanks, Rahat')).toBe('Sure.');
    expect(stripQuoted('Merci.\n\nLe lun. 6 oct. 2026 a 10:12, Rahat <r@x.com> a écrit :\nhappy to interview')).toBe('Merci.');
    expect(stripQuoted('<div style="display:none">preheader schedule a call tomorrow</div><div>Thanks</div><!-- schedule a call --><!--[if mso]><p>interview</p><![endif]-->')).toBe('Thanks');
    expect(stripQuoted('<p>Caf&#233; &#x26; Tea &rsquo;ok&rsquo; &amp;lt;b&amp;gt;</p>')).toBe("Café & Tea 'ok' &lt;b&gt;");
    expect(stripQuoted('<div>Ok.</div><div class="yahoo_quoted">happy to interview</div>')).toBe('Ok.');
  });
  it('freemail recipients are never matched by domain (widened list)', () => {
    for (const d of ['protonmail.com', 'proton.me', 'zoho.com', 'zohomail.in', 'aol.com', 'yahoo.in', 'ymail.com', 'live.in', 'outlook.in', 'hotmail.co.uk', 'me.com', 'msn.com', 'gmx.com', 'mail.com']) {
      const one = [sent({ email_to: `x@${d}`, thread_id: null })];
      expect(matchReply({ message_id: 'r', from: `y@${d}`, subject: '', body: '' }, one).via).toBe('none');
      expect(buildReplyQuery(one)).not.toContain(`from:${d} `);
    }
  });
});
