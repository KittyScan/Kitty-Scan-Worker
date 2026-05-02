/**
 * Thin client for Apple's App Store Server API.
 *
 * Single endpoint we care about (today): `GET /inApps/v1/transactions/{txId}`,
 * which returns a `signedTransactionInfo` JWS. We verify that JWS, decode
 * its payload, and use it as the trust source for "this user really bought
 * this product."
 *
 * Apple gives us two base URLs — sandbox for TestFlight / Sandbox Tester
 * accounts, production for shipped builds. The recommended pattern is:
 *   try production first → on 404 (NOT_FOUND), retry against sandbox.
 * That single function lets the same Worker serve both worlds without
 * an explicit env switch.
 */

import { signAppStoreServerJWT, type AppleJWTConfig } from './apple-jwt';
import { decodeJWSUnsafe, verifyJWSSignature, type DecodedTransaction } from './apple-jws';

const PROD_BASE = 'https://api.storekit.itunes.apple.com';
const SANDBOX_BASE = 'https://api.storekit-sandbox.itunes.apple.com';

export interface VerifiedTransaction {
  /// The decoded payload — what we trust.
  transaction: DecodedTransaction;
  /// Which Apple environment served this verification (Production / Sandbox).
  environment: 'Production' | 'Sandbox';
}

export type LookupResult =
  | { ok: true; transaction: VerifiedTransaction }
  | { ok: false; status: number; reason: string };

/// Verify a transaction by its ID against Apple's authoritative API.
/// Tries production first; transparently retries against sandbox on 404.
export async function verifyTransactionId(
  txId: string,
  config: AppleJWTConfig,
): Promise<LookupResult> {
  const jwt = await signAppStoreServerJWT(config);

  // Try production
  const prod = await fetchTransaction(PROD_BASE, txId, jwt);
  if (prod.ok) return await consumeResponse(prod, 'Production');
  if (prod.status !== 404) {
    return { ok: false, status: prod.status, reason: `prod_${prod.status}` };
  }

  // Production said NOT_FOUND → try sandbox
  const sb = await fetchTransaction(SANDBOX_BASE, txId, jwt);
  if (sb.ok) return await consumeResponse(sb, 'Sandbox');
  return { ok: false, status: sb.status, reason: `sandbox_${sb.status}` };
}

interface RawResp {
  ok: boolean;
  status: number;
  body: () => Promise<{ signedTransactionInfo?: string }>;
}

async function fetchTransaction(base: string, txId: string, jwt: string): Promise<RawResp> {
  const resp = await fetch(`${base}/inApps/v1/transactions/${txId}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/json',
    },
  });
  return {
    ok: resp.ok,
    status: resp.status,
    body: () => resp.json() as Promise<{ signedTransactionInfo?: string }>,
  };
}

async function consumeResponse(
  raw: RawResp,
  environment: 'Production' | 'Sandbox',
): Promise<LookupResult> {
  const body = await raw.body();
  const jws = body.signedTransactionInfo;
  if (!jws) {
    return { ok: false, status: 502, reason: 'no_signed_info' };
  }

  // Cryptographic check: the JWS must be signed by Apple's leaf cert,
  // which itself chains to Apple Root CA - G3. We currently verify the
  // leaf signature (apple-jws.ts) — that's enough when paired with this
  // direct call to Apple, because the response itself comes over HTTPS
  // from api.storekit.itunes.apple.com (cert-pinned by Cloudflare's TLS
  // stack). Forging this would require also forging Apple's TLS cert.
  if (!(await verifyJWSSignature(jws))) {
    return { ok: false, status: 401, reason: 'jws_signature_invalid' };
  }
  const decoded = decodeJWSUnsafe<DecodedTransaction>(jws);
  if (!decoded) {
    return { ok: false, status: 502, reason: 'jws_decode_failed' };
  }
  return { ok: true, transaction: { transaction: decoded, environment } };
}
