/**
 * Sign short-lived ES256 JWTs for the App Store Server API.
 *
 * Apple requires every request to its server-to-server endpoints (e.g.
 * `GET /inApps/v1/transactions/{txId}`) to carry a fresh JWT signed with
 * an ES256 (ECDSA P-256 + SHA-256) key downloaded from App Store Connect.
 *
 * The .p8 file contains a PKCS#8-wrapped private key in PEM. We strip the
 * PEM banners, base64-decode the body, and import via WebCrypto. WebCrypto
 * gives us native signing — no third-party JWT library, no node deps.
 *
 * Tokens are valid up to 60 minutes per Apple's spec; we issue 30-minute
 * tokens to leave generous slack for clock skew.
 */

export interface AppleJWTConfig {
  keyId: string;        // 10-char ID from App Store Connect
  issuerId: string;     // UUID from API key page
  bundleId: string;     // e.g. com.jingyan.CatHealthApp
  privateKeyPem: string; // .p8 PEM body (with or without banners)
}

export async function signAppStoreServerJWT(cfg: AppleJWTConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 30 * 60; // 30 min — well under Apple's 60-min cap

  const header = {
    alg: 'ES256',
    kid: cfg.keyId,
    typ: 'JWT',
  };
  const payload = {
    iss: cfg.issuerId,
    iat: now,
    exp,
    aud: 'appstoreconnect-v1',
    bid: cfg.bundleId,
  };

  const headerB64 = b64urlEncodeJSON(header);
  const payloadB64 = b64urlEncodeJSON(payload);
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await importP8PrivateKey(cfg.privateKeyPem);
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput),
  );
  const sigB64 = b64urlEncode(new Uint8Array(sig));

  return `${signingInput}.${sigB64}`;
}

/// Imports the .p8 PKCS#8 private key into WebCrypto. Strips PEM banners,
/// base64-decodes, and feeds the raw DER to `subtle.importKey`.
async function importP8PrivateKey(pem: string): Promise<CryptoKey> {
  const stripped = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const der = base64ToBytes(stripped);
  // Pass the Uint8Array directly — it's a valid BufferSource for
  // subtle.importKey. Using `.buffer` would force TS to narrow
  // ArrayBufferLike → ArrayBuffer which fails on stricter compiler settings.
  return crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

// ---- base64url helpers ----

function b64urlEncodeJSON(obj: unknown): string {
  return b64urlEncodeString(JSON.stringify(obj));
}

function b64urlEncodeString(s: string): string {
  return b64urlEncode(new TextEncoder().encode(s));
}

function b64urlEncode(bytes: Uint8Array): string {
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]!);
  return btoa(str)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
