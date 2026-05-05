/**
 * Per-call activity logging — feeds the /admin dashboard's Activity panel.
 *
 * Why a separate KV prefix and not a third-party analytics SDK?
 *   • Zero new credentials / SDK weight in the Worker bundle.
 *   • Same trust boundary as everything else — data we already own.
 *   • Cheap: one KV write per analyze, ~30B value, 30-day TTL.
 *
 * Writes happen inside `ctx.waitUntil` from the call sites so they never
 * block a user-facing response. A failed log write silently drops — we
 * accept the gap rather than corrupting the user experience for telemetry.
 */

const LOG_RETENTION_DAYS = 30;
const TTL_SECONDS = 60 * 60 * 24 * LOG_RETENTION_DAYS;

export interface CallLogEntry {
  /** "analyze" | "agent" | "consume" — keep short, used for dashboard slicing. */
  route: string;
  /** Outcome: "ok" | "upstream_error" | "rate_limited" | "quota_exhausted" | etc. */
  status: string;
  /** Claude model id — picks up server-side overrides, not the client-claimed tier. */
  model?: string;
  /** "free" | "pack" | "sub" at the moment of the call. */
  tier?: string;
  /** End-to-end Worker time in ms (excluding SSE keep-alive). */
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** First 8 chars of the account-token — enough for cohort grouping, not for re-identification. */
  tokenShort?: string;
  /** First 8 chars of the device-id — same idea, helps spot multi-device users. */
  deviceShort?: string;
  /** Country from CF-IPCountry, used for geo distribution. */
  country?: string;
}

export async function logCall(
  kv: KVNamespace,
  entry: CallLogEntry,
): Promise<void> {
  const now = Date.now();
  // Reverse-timestamp prefix keeps newest entries first when KV-listing,
  // matching the same pattern feedback uses. Random suffix avoids
  // collision when two calls hit the same millisecond.
  const reverseTs = String(Number.MAX_SAFE_INTEGER - now).padStart(20, '0');
  const suffix = Math.random().toString(36).slice(2, 8);
  const key = `log:${reverseTs}:${suffix}`;

  const record = {
    ts: new Date(now).toISOString(),
    ...entry,
  };

  try {
    await kv.put(key, JSON.stringify(record), { expirationTtl: TTL_SECONDS });
  } catch (e) {
    // Don't break the user request because telemetry failed.
    console.warn('[analytics] log write failed', e);
  }
}

/**
 * Helper used by /admin to compute percentiles from an unsorted array.
 * Returns whole-number ms (sub-ms precision isn't useful at this scale).
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[idx] ?? 0);
}
