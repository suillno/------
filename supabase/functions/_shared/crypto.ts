// refresh token 암호화와 OAuth state·PKCE 값. WebCrypto만 사용한다(Deno·Node 공통).
// 키(TOKEN_ENCRYPTION_KEY)는 Edge Function 비밀에만 있으며 DB에는 암호문만 저장한다.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomBase64Url(byteLength = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** RFC 7636 S256 code_challenge */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

/** base64로 인코딩한 32바이트 키만 받는다. */
export async function importTokenKey(base64Key: string | undefined): Promise<CryptoKey> {
  if (!base64Key) throw new Error("TOKEN_ENCRYPTION_KEY가 설정되지 않았습니다");
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = fromBase64(base64Key.trim());
  } catch {
    throw new Error("TOKEN_ENCRYPTION_KEY는 base64여야 합니다");
  }
  if (raw.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY는 32바이트여야 합니다");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** 형식: v1.<iv base64>.<암호문 base64> */
export async function encryptSecret(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext)));
  return `v1.${toBase64(iv)}.${toBase64(ct)}`;
}

export async function decryptSecret(key: CryptoKey, ciphertext: string): Promise<string> {
  const parts = ciphertext.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("지원하지 않는 암호문 형식입니다");
  const iv = fromBase64(parts[1]!);
  const ct = fromBase64(parts[2]!);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return decoder.decode(pt);
}
