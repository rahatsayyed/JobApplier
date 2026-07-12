import type { FieldMap } from './types.js';

const PLATFORM = 'ashby';

export function detect(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.endsWith('ashbyhq.com') ? PLATFORM : null;
  } catch {
    return null;
  }
}

export const fieldMap: FieldMap = {
  name: 'input[id^="_systemfield_name"]',
  email: 'input[id^="_systemfield_email"]',
  phone: 'input[id^="_systemfield_phone"]',
  resumeUpload: 'input[type="file"]',
  coverLetter: 'textarea[name="coverLetter"]',
  submitButton: 'button[type="submit"]',
};
