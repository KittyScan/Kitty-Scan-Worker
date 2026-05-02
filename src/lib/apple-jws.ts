/**
 * Verify and decode Apple-signed JWS payloads.
 *
 * Apple signs receipts and Server Notifications with a chain rooted at the
 * Apple Root CA - G3 (ECC). The JWS header `x5c` field carries the leaf,
 * intermediate, and root certificates as base64-DER. To verify:
 *   1. Confirm the root in `x5c` chains up to Apple's known root cert.
 *   2. Verify the leaf cert's signature on the header.payload bytes.
 *
 * For v1 we do a *structural* verify (confirm signature with the leaf cert
 * embedded in the JWS) AND we cross-check key fields (bundleId, environment)
 * against expectations. We DO NOT yet pin the root — a malicious party with
 * any valid ECDSA key could forge a JWS that passes leaf-verification.
 *
 * Hardening TODO before launch:
 *   - Embed Apple Root CA - G3 SHA256 fingerprint as a constant
 *   - Walk x5c chain and require root match
 *   - Verify cert NotBefore / NotAfter
 *   - Confirm leaf is for purpose=appleAppStore
 *
 * For now the structural verify + bundle-id check + (later) App Store Server
 * API cross-reference is the practical bar: any forgery would need to also
 * fake an HTTPS response from Apple, which is beyond the scope.
 */

export interface DecodedTransaction {
  // Subset we care about — full schema at https://developer.apple.com/documentation/appstoreservernotifications/jwstransactiondecodedpayload
  transactionId: string;
  originalTransactionId: string;
  productId: string;
  bundleId: string;
  purchaseDate: number;          // ms epoch
  expiresDate?: number;          // ms epoch (subs only)
  type: 'Auto-Renewable Subscription' | 'Consumable' | 'Non-Consumable' | 'Non-Renewing Subscription';
  appAccountToken?: string;      // UUID we sent on purchase
  environment: 'Production' | 'Sandbox';
  revocationDate?: number;       // present iff refund/revoke
}

export interface DecodedNotification {
  notificationType: string;      // SUBSCRIBED, DID_RENEW, EXPIRED, REFUND, REVOKE, ...
  subtype?: string;
  data?: {
    bundleId?: string;
    environment?: 'Production' | 'Sandbox';
    signedTransactionInfo?: string;   // nested JWS — decode separately
    signedRenewalInfo?: string;
  };
}

/** Pull the JSON payload out of a JWS *without* signature verification.
 *  Use only when the JWS is going to be cross-verified another way (e.g.
 *  by hitting Apple's App Store Server API with the transactionId). */
export function decodeJWSUnsafe<T>(jws: string): T | null {
  const parts = jws.split('.');
  if (parts.length !== 3) return null;
  const payload = parts[1];
  if (!payload) return null;
  try {
    return JSON.parse(b64urlDecode(payload)) as T;
  } catch { return null; }
}

/** Verify the JWS using the leaf cert in its own `x5c` header. Catches:
 *   - tampered payload (signature won't validate)
 *   - junk strings (parse fails)
 *  Doesn't catch:
 *   - someone forging a fresh JWS with a self-issued ECDSA key
 *  -> always pair with cross-check (App Store Server API or notification webhook). */
export async function verifyJWSSignature(jws: string): Promise<boolean> {
  const parts = jws.split('.');
  if (parts.length !== 3) return false;
  const headerB64 = parts[0];
  const payloadB64 = parts[1];
  const sigB64 = parts[2];
  if (!headerB64 || !payloadB64 || !sigB64) return false;

  let header: { x5c?: string[]; alg?: string };
  try { header = JSON.parse(b64urlDecode(headerB64)); }
  catch { return false; }

  if (header.alg !== 'ES256') return false;
  if (!header.x5c || header.x5c.length === 0) return false;
  const leafCertB64 = header.x5c[0];
  if (!leafCertB64) return false;

  // Pull the leaf certificate (first entry in x5c, base64-DER).
  let leafKey: CryptoKey;
  try {
    const leafDer = b64ToBytes(leafCertB64);
    leafKey = await importPublicKeyFromCertificateDER(leafDer);
  } catch (e) {
    return false;
  }

  const sigBytes = b64urlToBytes(sigB64);
  // The signature on a P-256 JWS is a 64-byte concatenation r||s.
  // WebCrypto expects this raw form for ECDSA verify with P-256.
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  return await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    leafKey,
    sigBytes,
    data,
  );
}

/** Extract the SubjectPublicKeyInfo from a DER-encoded X.509 cert and
 *  import it as a CryptoKey. We do this by hand because Workers doesn't
 *  ship a full X.509 parser and the SPKI offset is reliably the last
 *  91 bytes for P-256 EC certs (uncompressed point). */
async function importPublicKeyFromCertificateDER(certDer: Uint8Array): Promise<CryptoKey> {
  // Walk DER to find OID 1.2.840.10045.2.1 (ecPublicKey) followed by
  // OID 1.2.840.10045.3.1.7 (P-256). The SubjectPublicKeyInfo is then a
  // SEQUENCE { AlgorithmIdentifier, BIT STRING }. The BIT STRING contains
  // the uncompressed EC point (0x04 || X || Y) for P-256.
  //
  // Robust parsing is non-trivial. The pragmatic approach for Apple-signed
  // certs (which have a stable structure): scan for the trailing
  // `0x03 0x42 0x00 0x04` (BIT STRING tag, length 66 bytes, no unused bits,
  // uncompressed point indicator) which marks the start of the public-key
  // bytes. The 65 bytes after `0x04` are the SPKI body.
  for (let i = 0; i < certDer.length - 70; i++) {
    if (certDer[i] === 0x03 && certDer[i + 1] === 0x42 && certDer[i + 2] === 0x00 && certDer[i + 3] === 0x04) {
      // Re-construct an SPKI envelope around the EC point so subtle.importKey
      // accepts it. Hardcoded prefix: SEQUENCE { ecPublicKey OID, P-256 OID }.
      const prefix = new Uint8Array([
        0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86,
        0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
        0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03,
        0x42, 0x00,
      ]);
      const point = certDer.slice(i + 3, i + 3 + 66); // 0x04 || X || Y → 66 bytes incl. prefix byte
      const spki = new Uint8Array(prefix.length + point.length);
      spki.set(prefix, 0);
      spki.set(point, prefix.length);
      return await crypto.subtle.importKey(
        'spki',
        spki.buffer,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
    }
  }
  throw new Error('public key not found in cert DER');
}

// ---- base64 helpers ----

function b64urlDecode(s: string): string {
  // base64url → base64
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return atob(b64);
}

function b64urlToBytes(s: string): Uint8Array {
  const bin = b64urlDecode(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
