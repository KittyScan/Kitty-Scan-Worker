/**
 * Lightweight Web Application Firewall — runs first on every request.
 *
 * What it catches (in practice ≥ 95% of casual probing):
 *   • Bot/scanner User-Agent strings (curl, python-requests, scrapy, etc.)
 *   • Empty / suspiciously short User-Agent
 *   • Requests with no User-Agent at all
 *
 * What it does NOT catch (handled elsewhere):
 *   • Forged iOS-shaped User-Agents — those need App Attest (Layer 2)
 *   • Sustained DDoS — handled by Cloudflare's network-level protection
 *     (free tier already deflects volumetric attacks before they reach us)
 *
 * Design philosophy: cheap, fail-fast checks at the edge. Nothing here
 * touches KV or external services so a flood of bot traffic costs us
 * essentially nothing.
 */

export interface WAFVerdict {
  allowed: boolean;
  reason?: string;
}

/// Patterns that match obvious non-browser, non-iOS-app traffic.
/// We're explicit about not blocking *all* automation — Apple itself
/// uses CFNetwork-based agents — but these patterns cover the
/// "someone curl'd our endpoint" case which is the entire point.
const BOT_UA_PATTERNS: RegExp[] = [
  /\bbot\b/i,
  /crawler/i,
  /spider/i,
  /scrapy/i,
  /scanner/i,
  /wget/i,
  /^curl\//i,                  // exact curl prefix; iOS Sim doesn't ship this
  /python-requests/i,
  /python-urllib/i,
  /go-http-client/i,
  /^java\//i,
  /okhttp\//i,                 // Android default — we're iOS-only
  /postman/i,
  /insomnia/i,
  /HTTPie/i,
];

const ALLOWED_PATHS_NO_UA = new Set<string>([
  '/health',                   // load balancer probes are User-Agent-less
  '/webhook/apple',            // Apple's notification servers identify by cert chain, UA can vary
]);

export function inspect(request: Request, pathname: string): WAFVerdict {
  // /health and Apple webhook can skip — those are infrastructure callers,
  // not user traffic, and we don't want to break them by demanding a UA.
  if (ALLOWED_PATHS_NO_UA.has(pathname)) return { allowed: true };

  const ua = request.headers.get('User-Agent') ?? '';

  // Empty or trivially short — virtually always a script.
  if (ua.length < 8) {
    return { allowed: false, reason: 'missing_user_agent' };
  }

  // Match against the known-bot list.
  for (const pattern of BOT_UA_PATTERNS) {
    if (pattern.test(ua)) {
      return { allowed: false, reason: 'blocked_user_agent' };
    }
  }

  return { allowed: true };
}
