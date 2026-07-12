import type { FieldMap } from './types.js';

const PLATFORM = 'lever';

export function detect(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.endsWith('lever.co') ? PLATFORM : null;
  } catch {
    return null;
  }
}

export const fieldMap: FieldMap = {
  name: 'input[name="name"]',
  email: 'input[name="email"]',
  phone: 'input[name="phone"]',
  resumeUpload: 'input[name="resume"]',
  coverLetter: 'textarea[name="comments"]',
  submitButton: 'button[type="submit"]',
};
