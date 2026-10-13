import { createHash } from 'node:crypto';

/** Short stable hex digest, used for ids derived from a URL or path (no secrets involved). */
export const shortHash = (s: string, len = 12): string => createHash('sha1').update(s).digest('hex').slice(0, len);

/** True once a provider's own deadline (epoch ms, optional) has passed: stop starting requests and return what you have. */
export const pastDeadline = (deadlineAt: number | undefined): boolean => deadlineAt !== undefined && Date.now() >= deadlineAt;
