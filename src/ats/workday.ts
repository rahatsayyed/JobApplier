import type { FieldMap } from './types.js';

const PLATFORM = 'workday';

export function detect(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.includes('myworkdayjobs.com') ? PLATFORM : null;
  } catch {
    return null;
  }
}

export const fieldMap: FieldMap = {
  name: '[data-automation-id="legalNameSection_firstName"]',
  email: '[data-automation-id="email"]',
  phone: '[data-automation-id="phone-number"]',
  resumeUpload: '[data-automation-id="file-upload-input-ref"]',
  coverLetter: '[data-automation-id="coverLetter"]',
  submitButton: '[data-automation-id="bottom-navigation-next-button"]',
};
