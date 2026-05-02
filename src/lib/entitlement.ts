/**
 * Server-side entitlement ledger keyed on Apple's appAccountToken (UUID).
 *
 * Why account-token, not device-id:
 *   - One Apple ID can have multiple devices. Subscriptions follow the
 *     user, not the hardware. Pinning to device-id would orphan iPad users
 *     who bought on iPhone.
 *   - Apple includes the appAccountToken in every transaction's JWS payload,
 *     so we can join purchase events to user identity without trust.
 *
 * Key prefixes in RATE_KV:
 *   ent:<token>          → JSON {tier, monthlyResetsAt, packBalance, subAnalyzeUsed, subChatUsed, ...}
 *   txid:<txId>          → "<token>"  (de-dup ledger when webhook + client both report)
 *
 * We deliberately keep this in the same KV namespace as the rate-limit
 * counters to avoid juggling two namespaces in wrangler.toml. Different
 * prefixes keep them isolated.
 */

const TOKEN_RE = /^[0-9a-fA-F-]{36}$/;

export type Tier = 'free' | 'pack' | 'sub';

export interface Entitlement {
  tier: Tier;
  // Monthly subscription bookkeeping (ignored when tier !== 'sub')
  subActiveUntil?: number;       // ms epoch
  subPeriodStart?: number;       // ms epoch — period boundary for quota reset
  subAnalyzeUsed?: number;
  subChatUsed?: number;
  // Pack credits (ignored when tier !== 'pack')
  packBalance?: number;
  // Audit
  lastUpdatedAt: number;
}

/** Soft caps — must mirror iOS SubscriptionManager. */
export const SUB_MONTHLY_ANALYZES = 50;
export const SUB_MONTHLY_CHATS    = 30;

export function isValidToken(s: string | null): s is string {
  return !!s && TOKEN_RE.test(s);
}

const ENT_KEY = (token: string) => `ent:${token}`;
const TX_KEY  = (txId: string)  => `txid:${txId}`;

export async function loadEntitlement(token: string, kv: KVNamespace): Promise<Entitlement> {
  const raw = await kv.get(ENT_KEY(token));
  if (!raw) {
    return { tier: 'free', lastUpdatedAt: 0 };
  }
  try { return JSON.parse(raw) as Entitlement; }
  catch { return { tier: 'free', lastUpdatedAt: 0 }; }
}

export async function saveEntitlement(token: string, ent: Entitlement, kv: KVNamespace): Promise<void> {
  ent.lastUpdatedAt = Date.now();
  await kv.put(ENT_KEY(token), JSON.stringify(ent));
}

/** Has this transactionId already been credited? Prevents replay if both
 * the iOS client and the App Store Notifications webhook report it. */
export async function isTransactionApplied(txId: string, kv: KVNamespace): Promise<boolean> {
  return (await kv.get(TX_KEY(txId))) !== null;
}

export async function markTransactionApplied(txId: string, token: string, kv: KVNamespace): Promise<void> {
  // 90 day TTL — past that, subscription state has long since rolled over.
  await kv.put(TX_KEY(txId), token, { expirationTtl: 60 * 60 * 24 * 90 });
}

export interface AnalyzeGate {
  allowed: boolean;
  reason?: 'sub_analyze_quota' | 'pack_empty' | 'free_exhausted';
  remaining?: number;
}

/** Free quota for un-purchased users. Mirrors iOS `freeLifetimeAnalyses`.
 *  Tracked separately because un-purchased users have no Apple transactions
 *  to anchor on — we fall back to device-id rate limit + this counter. */
export const FREE_LIFETIME_ANALYZES = 3;

/** Decide whether a user with this entitlement can spend an analyze. Caller
 *  is responsible for incrementing the right counter on success. */
export function canAnalyze(ent: Entitlement, freeUsed: number): AnalyzeGate {
  // Sub takes precedence over pack takes precedence over free.
  if (ent.tier === 'sub' && (ent.subActiveUntil ?? 0) > Date.now()) {
    const used = ent.subAnalyzeUsed ?? 0;
    return used < SUB_MONTHLY_ANALYZES
      ? { allowed: true,  remaining: SUB_MONTHLY_ANALYZES - used - 1 }
      : { allowed: false, reason: 'sub_analyze_quota', remaining: 0 };
  }
  if (ent.tier === 'pack' && (ent.packBalance ?? 0) > 0) {
    return { allowed: true, remaining: (ent.packBalance ?? 0) - 1 };
  }
  return freeUsed < FREE_LIFETIME_ANALYZES
    ? { allowed: true,  remaining: FREE_LIFETIME_ANALYZES - freeUsed - 1 }
    : { allowed: false, reason: 'free_exhausted', remaining: 0 };
}

/** Decrement on a successful analyze. Mutates `ent` in place; caller saves. */
export function consumeAnalyze(ent: Entitlement) {
  if (ent.tier === 'sub' && (ent.subActiveUntil ?? 0) > Date.now()) {
    ent.subAnalyzeUsed = (ent.subAnalyzeUsed ?? 0) + 1;
  } else if (ent.tier === 'pack') {
    ent.packBalance = Math.max(0, (ent.packBalance ?? 0) - 1);
  }
  // Free-tier counter is tracked separately (see analyze.ts).
}

/** Apply a verified Apple transaction (purchase or renewal) to the ledger. */
export async function applyAppleTransaction(
  args: {
    token: string;
    productId: string;
    transactionId: string;
    expiresMs?: number;
    purchaseMs: number;
  },
  kv: KVNamespace,
): Promise<void> {
  if (await isTransactionApplied(args.transactionId, kv)) return;

  const ent = await loadEntitlement(args.token, kv);

  // Map productId → ledger effect. Must match iOS SubscriptionManager.ProductID.
  if (args.productId === 'com.jingyan.CatHealthApp.pack10') {
    ent.tier = ent.tier === 'sub' && (ent.subActiveUntil ?? 0) > Date.now() ? 'sub' : 'pack';
    ent.packBalance = (ent.packBalance ?? 0) + 10;
  } else if (args.productId === 'com.jingyan.CatHealthApp.pack30') {
    ent.tier = ent.tier === 'sub' && (ent.subActiveUntil ?? 0) > Date.now() ? 'sub' : 'pack';
    ent.packBalance = (ent.packBalance ?? 0) + 30;
  } else if (args.productId === 'com.jingyan.CatHealthApp.monthly') {
    ent.tier = 'sub';
    ent.subActiveUntil = args.expiresMs;
    // New billing period → reset usage counters
    if ((ent.subPeriodStart ?? 0) !== args.purchaseMs) {
      ent.subPeriodStart = args.purchaseMs;
      ent.subAnalyzeUsed = 0;
      ent.subChatUsed = 0;
    }
  } else {
    return; // unknown product
  }

  await saveEntitlement(args.token, ent, kv);
  await markTransactionApplied(args.transactionId, args.token, kv);
}

/** Strip subscription state on revoke/refund. Pack credits stay (consumables
 *  aren't refundable on Apple's side without a manual refund flow we'd have
 *  to handle separately — keep it simple for v1). */
export async function revokeSubscription(token: string, kv: KVNamespace): Promise<void> {
  const ent = await loadEntitlement(token, kv);
  if (ent.tier === 'sub') {
    ent.tier = (ent.packBalance ?? 0) > 0 ? 'pack' : 'free';
  }
  ent.subActiveUntil = undefined;
  await saveEntitlement(token, ent, kv);
}

/** Track free-tier analyze usage per token. Stored separately so that
 *  upgrading to a paid tier doesn't reset / lose the counter. */
const FREE_KEY = (token: string) => `free:${token}`;

export async function getFreeUsed(token: string, kv: KVNamespace): Promise<number> {
  const raw = await kv.get(FREE_KEY(token));
  return raw ? parseInt(raw, 10) : 0;
}

export async function incrementFreeUsed(token: string, kv: KVNamespace): Promise<void> {
  const cur = await getFreeUsed(token, kv);
  await kv.put(FREE_KEY(token), String(cur + 1));
}
