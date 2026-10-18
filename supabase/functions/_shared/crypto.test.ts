import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, importTokenKey, pkceChallenge } from "./crypto.ts";

// 테스트 실행마다 새로 만든 키. 실제 키를 소스에 두지 않는다.
function freshKey(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}

describe("토큰 암호화", () => {
  it("암호화한 값을 같은 키로만 복호화한다", async () => {
    const key = await importTokenKey(freshKey());
    const ct = await encryptSecret(key, "refresh-token-value");
    expect(ct).not.toContain("refresh-token-value");
    expect(await decryptSecret(key, ct)).toBe("refresh-token-value");
    await expect(decryptSecret(await importTokenKey(freshKey()), ct)).rejects.toThrow();
  });

  it("같은 값도 매번 다른 암호문을 만든다", async () => {
    const key = await importTokenKey(freshKey());
    expect(await encryptSecret(key, "x")).not.toBe(await encryptSecret(key, "x"));
  });

  it("키가 없거나 길이가 틀리면 거부한다", async () => {
    await expect(importTokenKey(undefined)).rejects.toThrow();
    await expect(importTokenKey(btoa("short"))).rejects.toThrow();
  });
});

describe("pkceChallenge", () => {
  it("RFC 7636 부록 B 예시와 같다", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});
