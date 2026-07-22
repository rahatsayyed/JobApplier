import { detectAts } from '../apply/external.js';

export type ApplyAutoRoute = { kind: 'linkedin' } | { kind: 'external'; platform: string | null };

function isLinkedInUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().endsWith('linkedin.com');
  } catch {
    return false;
  }
}

/**
 * Pure routing decision for the `apply.auto` tool: inspects `apply_url` and decides which
 * underlying apply path handles it. Never reimplements platform logic itself — a
 * `{kind: 'external', platform: null}` result means "no known platform matched; let
 * applyExternal's own bootstrap step (learn-or-manual_review) handle it," exactly the
 * no-expected_platform case self-extending ATS bootstrapping requires to ever fire.
 */
export function routeApplyAuto(applyUrl: string): ApplyAutoRoute {
  if (isLinkedInUrl(applyUrl)) return { kind: 'linkedin' };
  const ats = detectAts(applyUrl);
  return { kind: 'external', platform: ats?.platform ?? null };
}
