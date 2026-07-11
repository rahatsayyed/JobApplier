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
  // Greenhouse's application form has separate first-name and last-name inputs.
  // `name` is kept for shape backward-compatibility but `firstName`/`lastName`
  // are what fill logic should actually use.
  name: '#first_name',
  firstName: '#first_name',
  lastName: '#last_name',
  email: '#email',
  phone: '#phone',
  resumeUpload: '#resume',
  coverLetter: '#cover_letter_text',
  submitButton: '#submit_app',
};
