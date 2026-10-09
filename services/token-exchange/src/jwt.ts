// RS256 JWT helpers on Web Crypto, so the Worker needs no runtime
// dependencies.

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function base64UrlDecode(input: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) {
    throw new Error("Invalid base64url");
  }
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export type DecodedJwt = {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
};

export function decodeJwt(token: string): DecodedJwt {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed JWT");
  }
  const [header, payload, signature] = parts as [string, string, string];
  return {
    header: parseJsonObject(decoder.decode(base64UrlDecode(header))),
    payload: parseJsonObject(decoder.decode(base64UrlDecode(payload))),
    signingInput: new Uint8Array(encoder.encode(`${header}.${payload}`)),
    signature: base64UrlDecode(signature),
  };
}

function parseJsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("JWT segment is not a JSON object");
  }
  return value as Record<string, unknown>;
}

export type RsaJwk = { kty?: string; n?: string; e?: string; kid?: string };

export function importRsaPublicJwk(jwk: RsaJwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    RS256,
    false,
    ["verify"],
  );
}

export function verifyRs256(
  key: CryptoKey,
  decoded: DecodedJwt,
): Promise<boolean> {
  return crypto.subtle.verify(
    RS256,
    key,
    decoded.signature,
    decoded.signingInput,
  );
}

export async function signRs256Jwt(
  key: CryptoKey,
  payload: Record<string, unknown>,
): Promise<string> {
  const header = base64UrlEncode(
    encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })),
  );
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    RS256,
    key,
    encoder.encode(`${header}.${body}`),
  );
  return `${header}.${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

// GitHub hands out App private keys as PKCS#1 ("BEGIN RSA PRIVATE KEY"),
// which Web Crypto cannot import. Both PKCS#1 and PKCS#8 are accepted; PKCS#1
// is wrapped into PKCS#8 here.
export function importRsaPrivateKeyPem(pem: string): Promise<CryptoKey> {
  const normalized = pem.replace(/\\n/g, "\n");
  const match =
    /-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----([\s\S]+?)-----END \1-----/.exec(
      normalized,
    );
  if (!match) {
    throw new Error("Private key is not a PEM-encoded RSA key");
  }
  const der = base64ToBytes(match[2]!.replace(/\s+/g, ""));
  const pkcs8 = match[1] === "RSA PRIVATE KEY" ? wrapPkcs1InPkcs8(der) : der;
  return crypto.subtle.importKey("pkcs8", pkcs8, RS256, false, ["sign"]);
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// AlgorithmIdentifier { rsaEncryption, NULL }
const RSA_ALGORITHM_IDENTIFIER = [
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  0x05, 0x00,
];

function wrapPkcs1InPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  // PrivateKeyInfo ::= SEQUENCE { version INTEGER 0, AlgorithmIdentifier,
  //                               privateKey OCTET STRING }
  return derTlv(0x30, [
    0x02,
    0x01,
    0x00,
    ...RSA_ALGORITHM_IDENTIFIER,
    ...derTlv(0x04, Array.from(pkcs1)),
  ]);
}

function derTlv(tag: number, content: number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array([tag, ...derLength(content.length), ...content]);
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return [0x80 | bytes.length, ...bytes];
}
