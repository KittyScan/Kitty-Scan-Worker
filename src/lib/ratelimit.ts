/**
 * Per-Device-Id rate limit backed by KV.
 *
 * Two rolling windows:
 *   daily  -> key `day:<deviceId>:<YYYY-MM-DD>`
 *   monthly -> key `month:<deviceId>:<YYYY-MM>`
 *
 * KV is eventually consistent which means under heavy concurrent traffic a user
 * *might* sneak 1-2 over the limit. For a 3/day consumer cap that's acceptable;
 * if this ever tightens, move to Durable Objects.
 */

export interface RateResult {
  allowed: boolean;
  reason?: 'daily' | 'monthly';
  /** Unix seconds when the relevant window resets */
  resetAt?: number;
  /** Current counts (for debug/telemetry headers) */
  dayCount: number;
  monthCount: number;
}

export async function checkAndIncrement(
  deviceId: string,
  kv: KVNamespace,
  dayLimit: number,
  monthLimit: number,
): Promise<RateResult> {
  const now = new Date();
  const day = toDayKey(now);
  const month = toMonthKey(now);

  const dayKey = `day:${deviceId}:${day}`;
  const monthKey = `month:${deviceId}:${month}`;

  const [dayStr, monthStr] = await Promise.all([kv.get(dayKey), kv.get(monthKey)]);
  const dayCount = parseInt(dayStr || '0', 10);
  const monthCount = parseInt(monthStr || '0', 10);

  if (dayCount >= dayLimit) {
    return {
      allowed: false,
      reason: 'daily',
      resetAt: endOfDayEpoch(now),
      dayCount,
      monthCount,
    };
  }
  if (monthCount >= monthLimit) {
    return {
      allowed: false,
      reason: 'monthly',
      resetAt: endOfMonthEpoch(now),
      dayCount,
      monthCount,
    };
  }

  // Bump counters. TTL is generous so we don't lose fresh data if wall clock drifts.
  await Promise.all([
    kv.put(dayKey, String(dayCount + 1), { expirationTtl: 86_400 * 2 }),
    kv.put(monthKey, String(monthCount + 1), { expirationTtl: 86_400 * 40 }),
  ]);

  return { allowed: true, dayCount: dayCount + 1, monthCount: monthCount + 1 };
}

/**
 * IP-level rate limit — defense against someone spinning up fresh Device IDs
 * to bypass the per-device cap. Tighter but still generous (20/hour from any single IP).
 * Keyed by CF-Connecting-IP (set by Cloudflare edge automatically).
 */
const IP_HOURLY_LIMIT = 20;

export interface IpRateResult {
  allowed: boolean;
  count: number;
}

export async function checkAndIncrementIp(ip: string, kv: KVNamespace): Promise<IpRateResult> {
  if (!ip) return { allowed: true, count: 0 }; // don't block if CF header absent (dev/local)
  const hourKey = `ip:${ip}:${toHourKey(new Date())}`;
  const current = parseInt((await kv.get(hourKey)) || '0', 10);
  if (current >= IP_HOURLY_LIMIT) {
    return { allowed: false, count: current };
  }
  await kv.put(hourKey, String(current + 1), { expirationTtl: 3_900 }); // 65 min
  return { allowed: true, count: current + 1 };
}

function toHourKey(d: Date): string {
  return d.toISOString().slice(0, 13); // YYYY-MM-DDTHH
}

function toDayKey(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}
function toMonthKey(d: Date): string {
  return d.toISOString().slice(0, 7); // YYYY-MM
}
function endOfDayEpoch(d: Date): number {
  const end = new Date(d);
  end.setUTCHours(23, 59, 59, 999);
  return Math.floor(end.getTime() / 1000);
}
function endOfMonthEpoch(d: Date): number {
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59, 999));
  return Math.floor(end.getTime() / 1000);
}
