import type { Env } from '../index';
import { json } from '../lib/http';
import {
  applyAppleTransaction,
  revokeSubscription,
} from '../lib/entitlement';
import {
  decodeJWSUnsafe,
  verifyJWSSignature,
  type DecodedNotification,
  type DecodedTransaction,
} from '../lib/apple-jws';

/**
 * App Store Server Notifications V2 webhook.
 *
 * Apple POSTs a `signedPayload` (JWS) when subscription state changes:
 * SUBSCRIBED, DID_RENEW, EXPIRED, REFUND, REVOKE, etc. We verify the JWS,
 * decode, and update the entitlement ledger.
 *
 * Configure in App Store Connect:
 *   App Information → App Store Server Notifications → Production / Sandbox URL
 *   → https://carmel-worker.../webhook/apple
 *
 * For local dev: Apple won't reach localhost; use Cloudflare Worker dev
 * tunnel and set the SANDBOX URL to the tunnel.
 */

interface SignedPayload {
  signedPayload: string;
}

const RELEVANT_NOTIFICATIONS = new Set([
  'SUBSCRIBED',
  'DID_RENEW',
  'DID_CHANGE_RENEWAL_STATUS',
  'EXPIRED',
  'GRACE_PERIOD_EXPIRED',
  'REFUND',
  'REVOKE',
]);

export async function handleAppleWebhook(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  let body: SignedPayload;
  try { body = (await request.json()) as SignedPayload; }
  catch { return json({ error: 'invalid_json' }, 400); }

  if (!body.signedPayload || typeof body.signedPayload !== 'string') {
    return json({ error: 'missing_signed_payload' }, 400);
  }

  // Verify the outer notification JWS first.
  if (!(await verifyJWSSignature(body.signedPayload))) {
    console.warn('[webhook] outer JWS verify failed');
    return json({ error: 'invalid_signature' }, 401);
  }

  const notif = decodeJWSUnsafe<DecodedNotification>(body.signedPayload);
  if (!notif) return json({ error: 'invalid_payload' }, 400);

  // Bundle-id sanity check — different bundle = not for us.
  // (Will be a no-op until APPLE_BUNDLE_ID is set; see wrangler.toml.)
  const expectedBundle = (env as unknown as { APPLE_BUNDLE_ID?: string }).APPLE_BUNDLE_ID;
  if (expectedBundle && notif.data?.bundleId && notif.data.bundleId !== expectedBundle) {
    return json({ ok: true, ignored: 'wrong_bundle' }, 200);
  }

  if (!RELEVANT_NOTIFICATIONS.has(notif.notificationType)) {
    return json({ ok: true, ignored: notif.notificationType }, 200);
  }

  // Inner transaction JWS carries the actual purchase details.
  const innerJws = notif.data?.signedTransactionInfo;
  if (!innerJws) return json({ error: 'missing_transaction_info' }, 400);
  if (!(await verifyJWSSignature(innerJws))) {
    return json({ error: 'invalid_inner_signature' }, 401);
  }

  const tx = decodeJWSUnsafe<DecodedTransaction>(innerJws);
  if (!tx) return json({ error: 'invalid_inner_payload' }, 400);
  if (!tx.appAccountToken) {
    // Notification for a purchase made without our account token (legacy
    // receipts before we wired this up). Skip — there's nothing to bind to.
    return json({ ok: true, ignored: 'no_account_token' }, 200);
  }

  switch (notif.notificationType) {
    case 'SUBSCRIBED':
    case 'DID_RENEW':
      await applyAppleTransaction(
        {
          token: tx.appAccountToken,
          productId: tx.productId,
          transactionId: tx.transactionId,
          expiresMs: tx.expiresDate,
          purchaseMs: tx.purchaseDate,
        },
        env.RATE_KV,
      );
      break;
    case 'EXPIRED':
    case 'GRACE_PERIOD_EXPIRED':
    case 'REFUND':
    case 'REVOKE':
      await revokeSubscription(tx.appAccountToken, env.RATE_KV);
      break;
    case 'DID_CHANGE_RENEWAL_STATUS':
      // No immediate ledger effect — auto-renew off just means it'll EXPIRE
      // at the period end, which we'll handle then.
      break;
  }

  return json({ ok: true }, 200);
}
