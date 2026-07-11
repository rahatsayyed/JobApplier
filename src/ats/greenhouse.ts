import type { FieldMap } from './types.js';

const PLATFORM = 'greenhouse';

export function detect(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.endsWith('greenhouse.io') ? PLATFORM : null;
  } catch {
    return null;
  }
}

export const fieldMap: FieldMap = {
  name: '#first_name',
  email: '#email',
  phone: '#phone',
  resumeUpload: '#resume',
  coverLetter: '#cover_letter_text',
  submitButton: '#submit_app',
};
